import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function callClaude(params, retries = 5) {
    for (let i = 0; i < retries; i++) {
        try {
            return await client.messages.create(params);
        } catch (err) {
            const is403 = err.status === 403 || err.message?.includes('403');
            const is429 = err.status === 429 || err.message?.includes('429');
            const isCredit = err.status === 400 && err.message?.includes('credit balance');
            if (isCredit) throw new Error('Anthropic account out of credits');
            if ((is403 || is429) && i < retries - 1) {
                const wait = is429 ? 70000 + i * 30000 : (i + 1) * 60000;
                console.log(`  ${is429 ? 'Rate limit (429)' : 'Cloudflare block (403)'} on attempt ${i + 1}, retrying in ${wait / 1000}s...`);
                await sleep(wait);
                continue;
            }
            throw err;
        }
    }
}

export async function analyzeBusiness(crawlData) {
    const prompt = `You are a business analyst and web strategist. Analyze this website data and return a detailed JSON object.

Website data:
- URL: ${crawlData.url}
- Title: ${crawlData.title}
- Meta description: ${crawlData.metaDesc}
- Navigation: ${crawlData.navLinks.map(l => l.text).join(', ')}
- Main headings: ${crawlData.headings.join(' | ')}
- Body content sample: ${crawlData.paragraphs.slice(0, 15).join(' ')}
- CTAs found: ${crawlData.ctas.join(', ')}
- Forms: ${crawlData.forms.length} form(s) with fields: ${crawlData.forms.map(f => f.fields.join(', ')).join('; ')}
- Current sections: ${crawlData.sections.map(s => s.heading || s.id).join(', ')}
- Social presence: ${crawlData.socialLinks.join(', ')}
- Footer: ${crawlData.footerText}

Return ONLY a valid JSON object with this structure:
{
  "businessName": "string",
  "businessType": "string",
  "industry": "string",
  "targetAudience": "string",
  "location": "string or null",
  "primaryOfferings": ["array of main products/services"],
  "tone": "string",
  "currentStrengths": ["what the current site does well"],
  "currentWeaknesses": ["what the current site is missing or doing poorly"],
  "recommendedSections": [{ "name": "string", "priority": "high/medium/low", "reason": "string" }],
  "recommendedFeatures": [{ "feature": "string", "reason": "string", "priority": "high/medium/low" }],
  "contentGaps": ["content that should exist but was not found"],
  "competitiveAdvantage": "string",
  "colorPersonality": "string",
  "seoKeywords": ["5-8 keywords"]
}`;

    const response = await callClaude({
        model: 'claude-sonnet-4-6',
        max_tokens: 4096,
        system: 'You are a JSON-only responder. Output raw JSON with no markdown, no code fences, no explanation.',
        messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0].text.trim();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1) throw new Error('No JSON found in response: ' + text.slice(0, 200));
    return JSON.parse(text.slice(start, end + 1));
}
