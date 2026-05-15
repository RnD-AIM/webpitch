import Anthropic from '@anthropic-ai/sdk';

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function callClaude(params, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            return await claude.messages.create(params);
        } catch (err) {
            const is403 = err.status === 403 || err.message?.includes('403');
            if (is403 && i < retries - 1) {
                const wait = (i + 1) * 60000;
                console.log(`    Cloudflare block attempt ${i + 1}, retrying in ${wait / 1000}s...`);
                await sleep(wait);
                continue;
            }
            throw err;
        }
    }
}

export async function generateProposal(analysis, designs, crawlData, jobId, baseUrl) {
    const designSummary = designs.map(d => {
        const pageList = d.pages ? d.pages.map(p => p.title).join(', ') : 'Home, Services, About, Contact';
        return `Design ${d.index} — "${d.name}": Uses the "${d.palette.name}" palette (${d.palette.primary}, ${d.palette.secondary}, ${d.palette.accent}). ${d.palette.concept || d.palette.rationale || ''}. Pages: ${pageList}.`;
    }).join('\n');

    const designLinks = designs.map(d =>
        `- Design ${d.index} (${d.name}): ${baseUrl}/output/${jobId}/${d.dir}/index.html`
    ).join('\n');

    const prompt = `You are a senior web strategist writing a professional website redesign proposal for a client.

BUSINESS: ${analysis.businessName} (${analysis.businessType})
EXISTING SITE: ${crawlData.url}

ANALYSIS FINDINGS:
- Target audience: ${analysis.targetAudience}
- Current strengths: ${analysis.currentStrengths.join('; ')}
- Current weaknesses: ${analysis.currentWeaknesses.join('; ')}
- Recommended features: ${analysis.recommendedFeatures.filter(f => f.priority === 'high').map(f => f.feature).join(', ')}
- Content gaps: ${analysis.contentGaps.join('; ')}
- Competitive advantage to emphasize: ${analysis.competitiveAdvantage}

THREE MULTI-PAGE DESIGNS PREPARED:
Each design is a full 4-page website (Home, Services, About, Contact) with a shared CSS design system.
${designSummary}

Write a professional proposal as a complete HTML document. Include:
1. Executive summary (what we found, what we're proposing)
2. Current site analysis (strengths and opportunities, be tactful)
3. Recommended site structure with rationale for each section
4. Design proposals section — explain each of the 3 designs, what it communicates, who it appeals to
5. Recommended features and why (highlight high-priority ones)
6. Missing content that the client needs to provide
7. Next steps

Style: Professional but warm. This is a pitch to win the redesign project. Be specific about the business.
Format: Standalone HTML with embedded CSS. Clean, professional document styling. No external dependencies.
Include navigation links to the three designs:
${designLinks}

Return ONLY the complete HTML. No markdown fences.`;

    const response = await callClaude({
        model: 'claude-sonnet-4-6',
        max_tokens: 6000,
        messages: [{ role: 'user', content: prompt }],
    });

    return response.content[0].text.trim();
}
