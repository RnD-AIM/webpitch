import Anthropic from '@anthropic-ai/sdk';

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function callClaude(params, retries = 5) {
    for (let i = 0; i < retries; i++) {
        try {
            return await claude.messages.create(params);
        } catch (err) {
            const is403 = err.status === 403 || err.message?.includes('403');
            const is429 = err.status === 429 || err.message?.includes('429');
            const isCredit = err.status === 400 && err.message?.includes('credit balance');
            if (isCredit) throw new Error('Anthropic account out of credits — add credits at console.anthropic.com');
            if ((is403 || is429) && i < retries - 1) {
                const wait = is429 ? 70000 + i * 30000 : (i + 1) * 60000;
                console.log(`    ${is429 ? 'Rate limit (429)' : 'Cloudflare block (403)'} attempt ${i + 1}, retrying in ${wait / 1000}s...`);
                await sleep(wait);
                continue;
            }
            throw err;
        }
    }
}

// CSS-only pass: clean proposal document styles, focused call with room for all rules
async function generateProposalCSS(analysis) {
    const resp = await callClaude({
        model: 'claude-sonnet-4-6',
        max_tokens: 4000,
        messages: [{
            role: 'user',
            content: `Write CSS for a professional website redesign proposal document.

BUSINESS TYPE: ${analysis.businessType}
BRAND COLORS: primary #2563eb, dark #1e293b, light bg #f8fafc, accent #f59e0b

Requirements:
- Clean, professional consulting-report styling
- Fully responsive: readable on mobile and desktop (include @media max-width: 768px)
- Key sections: hero banner, executive summary, findings, design proposals, features, next steps
- Typography: system-ui font stack, clear heading hierarchy (h1 2.5rem, h2 1.8rem, h3 1.3rem)
- Accent #2563eb for headings, borders, and CTAs
- Design cards (.design-card): border 1px solid #e2e8f0, border-top 4px solid accent, border-radius 8px, padding 32px, margin-bottom 24px
- Feature tags (.feature-tag): display inline-block, background #2563eb, color white, border-radius 20px, padding 4px 14px, font-size 0.85rem, margin 4px
- Hero section (.proposal-hero): gradient dark bg (#1e293b to #2563eb), white text, padding 80px 24px, text-center
- .section: padding 64px 24px, max-width 880px, margin 0 auto
- .next-steps ol: list-style none, counter-reset steps; li::before counter in accent circle
- Print-friendly: no dark backgrounds on content sections
- Responsive @media (max-width: 768px): stack layouts, reduce padding, smaller headings

Return ONLY raw CSS. No markdown, no explanation.`,
        }],
    });
    return resp.content[0].text.trim()
        .replace(/^```css\n?/, '').replace(/\n?```$/, '');
}

// HTML body-only pass: the narrative content (no <style> tag)
// Receives proposalCSS for tonal reference but does not embed it
async function generateProposalBody(analysis, designs, crawlData, jobId, baseUrl, proposalCSS) {
    const designSummary = designs.map(d => {
        const pageList = d.pages ? d.pages.map(p => p.title).join(', ') : 'Home, Servicios, Nosotros, Contacto';
        return `Diseño ${d.index} — "${d.name}": Paleta "${d.palette.name}" (${d.palette.primary}, ${d.palette.secondary}, ${d.palette.accent}). ${d.palette.concept || d.palette.rationale || ''}. Páginas: ${pageList}.`;
    }).join('\n');

    const designLinks = designs.map(d =>
        `<a href="${baseUrl}/output/${jobId}/${d.dir}/index.html" class="design-link">Ver Diseño ${d.index} — ${d.name}</a>`
    ).join('\n');

    const resp = await callClaude({
        model: 'claude-sonnet-4-6',
        max_tokens: 5000,
        messages: [{
            role: 'user',
            content: `Write the HTML body content for a professional website redesign proposal.

IMPORTANT: Write ONLY the semantic HTML that goes inside <body>.
Do NOT include <html>, <head>, <style>, <body> tags. Just the content.
The CSS classes already available: .proposal-hero, .section, .design-card, .feature-tag, .next-steps

BUSINESS: ${analysis.businessName} (${analysis.businessType})
EXISTING SITE: ${crawlData.url}

ANALYSIS FINDINGS:
- Target audience: ${analysis.targetAudience}
- Current strengths: ${analysis.currentStrengths.join('; ')}
- Current weaknesses: ${analysis.currentWeaknesses.join('; ')}
- High-priority recommended features: ${analysis.recommendedFeatures.filter(f => f.priority === 'high').map(f => f.feature).join(', ')}
- Content gaps: ${analysis.contentGaps.join('; ')}
- Competitive advantage to emphasize: ${analysis.competitiveAdvantage}

THREE MULTI-PAGE DESIGNS PREPARED:
${designSummary}

Structure the body with these sections:
1. <section class="proposal-hero"> — title "Propuesta de Rediseño Web: ${analysis.businessName}" + compelling tagline about their digital opportunity
2. <section class="section"> Executive summary — 2-3 paragraphs on what was found and what is proposed, specific to this business
3. <section class="section"> Current site analysis — tactful strengths and improvement opportunities
4. <section class="section"> Design proposals — one <div class="design-card"> per design with name, palette summary, who it appeals to, and a view link:
${designLinks}
5. <section class="section"> Recommended features — use <span class="feature-tag"> for high-priority ones + explanation of each
6. <section class="section"> Content the client needs to prepare (specific to this business type)
7. <section class="section next-steps"> Next steps — clear numbered actions + CTA to move forward

Write in Spanish. Be specific about ${analysis.businessName}. Professional but warm tone.
Return ONLY the HTML body content. No wrapping tags, no code fences.`,
        }],
    });
    return resp.content[0].text.trim()
        .replace(/^```html\n?/, '').replace(/\n?```$/, '');
}

// Assembly: combine CSS + body into standalone HTML
export async function generateProposal(analysis, designs, crawlData, jobId, baseUrl) {
    console.log('    Generating proposal CSS...');
    const proposalCSS = await generateProposalCSS(analysis);

    console.log('    Generating proposal body...');
    const proposalBody = await generateProposalBody(analysis, designs, crawlData, jobId, baseUrl, proposalCSS);

    return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Propuesta de Rediseño — ${analysis.businessName}</title>
<style>
${proposalCSS}
</style>
</head>
<body>
${proposalBody}
</body>
</html>`;
}
