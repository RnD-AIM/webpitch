import Anthropic from '@anthropic-ai/sdk';
import axios from 'axios';
import { writeFile, readFile, mkdir } from 'fs/promises';
import { execFile } from 'child_process';
import path from 'path';


const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── helpers ────────────────────────────────────────────────────────────────

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

function extractJSON(text) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1) throw new Error('No JSON found in response');
    return JSON.parse(text.slice(start, end + 1));
}

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// Walk a content object and return all leaf paths as dot-notation strings
// Used to build the placeholder schema sent to generatePageTemplate
function buildPlaceholderSchema(sections) {
    function walk(obj, prefix) {
        if (obj == null) return [];
        if (Array.isArray(obj)) {
            return obj.flatMap((item, i) => walk(item, `${prefix}.${i}`));
        }
        if (typeof obj === 'object') {
            return Object.entries(obj).flatMap(([k, v]) => {
                const fullPath = `${prefix}.${k}`;
                if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
                    return [fullPath];
                }
                return walk(v, fullPath);
            });
        }
        return [];
    }
    return sections.flatMap(s => walk(s.content, s.type));
}

// Inject content into HTML template — resolves {{section_type.field}} paths from sections array
function renderTemplate(html, sections) {
    const byType = {};
    for (const s of sections) byType[s.type] = s.content;

    const rendered = html.replace(/\{\{([^}]+)\}\}/g, (match, path) => {
        const parts = path.trim().split('.');
        let val = byType;
        for (const part of parts) {
            if (val == null) return '';
            val = Array.isArray(val) ? val[parseInt(part)] : val[part];
        }
        return val != null ? escapeHtml(String(val)) : '';
    });

    const remaining = rendered.match(/\{\{[^}]+\}\}/g);
    if (remaining) {
        console.warn(`    ⚠ ${remaining.length} unresolved placeholder(s): ${remaining.slice(0, 5).join(', ')}`);
    }
    return rendered;
}

// Query the ui-ux-pro-max design intelligence database
// domain: 'color' | 'typography' | 'style' | 'ux' | 'landing'
async function queryUXPro(query, domain, n = 1) {
    return new Promise((resolve) => {
        const safeQuery = String(query).slice(0, 60);
        execFile('python3', ['/opt/webpitch/ui-ux-pro-max/scripts/search.py', safeQuery, '--domain', domain, '-n', String(n)], { timeout: 10000 }, (err, stdout) => {
            if (err) { resolve(''); return; }
            resolve(stdout.replace(/^##.*\n.*\n.*\n/, '').trim());
        });
    });
}

// ── defaults ───────────────────────────────────────────────────────────────

const DEFAULT_PALETTES = [
    {
        name: 'Modern Professional', concept: 'Clean, modern, trustworthy',
        primary: '#2563eb', secondary: '#1e40af', accent: '#f59e0b',
        background: '#ffffff', surface: '#f8fafc', text: '#1e293b', dark: '#0f172a',
    },
    {
        name: 'Bold & Energetic', concept: 'Dynamic, growth-oriented',
        primary: '#16a34a', secondary: '#15803d', accent: '#fbbf24',
        background: '#ffffff', surface: '#f0fdf4', text: '#111827', dark: '#052e16',
    },
    {
        name: 'Rich & Refined', concept: 'Premium, sophisticated, credible',
        primary: '#7c3aed', secondary: '#5b21b6', accent: '#f59e0b',
        background: '#fafaf9', surface: '#f5f3ff', text: '#1c1917', dark: '#1e1b4b',
    },
];

const DESIGN_STYLES = [
    {
        name: 'Modern & Bold',
        css_personality: `Clean white base. Large bold sans-serif headlines (clamp 3-5rem).
Gradient hero with diagonal CSS clip-path (polygon). Sticky nav with blur backdrop-filter.
Cards with subtle box-shadow on hover lift. Dark footer. Accent color on CTAs.
Stats displayed as oversized numbers (5-6rem) in a dark band.`,
        layout_patterns: `HOME: Full-viewport hero, 2-col grid (headline+CTAs left, 3 floating stat pills right), hero bg = gradient.
Below hero: narrow trust strip (5 icon+label items in a row).
Features: 3-col card grid with emoji icon, bold title, 20-word body.
Stats band: dark background, 4 huge numbers in a row.
Testimonials: 3 cards with star rating (★★★★★), italic quote, avatar initial circle.
CTA strip: gradient bg, centered headline + 2 buttons.
FOOTER: dark, 4-col grid (logo+tagline | links | links | social+contact).`,
    },
    {
        name: 'Dark & Dramatic',
        css_personality: `Near-black (#0d1117) base, crisp white text, electric accent glows.
Gradient text clips on hero headlines (background-clip: text).
Frosted glass cards (rgba background + backdrop-filter blur).
Neon-border buttons with glow on hover. Sections alternate dark/slightly-lighter.`,
        layout_patterns: `HOME: Full-dark viewport hero. Centered layout. Large gradient-clip headline (text as gradient).
Subtitle. 2 glass-morphism CTA buttons. Radial glow behind the headline.
Feature chips: horizontal scrollable row of pill-shape icon+label items.
Cards section: 3 glass-dark cards with accent top border, emoji icon, title, body.
Light breakout section (white bg): testimonials or social proof for contrast.
Dark stats band: 4 numbers glowing in accent color.
FOOTER: slightly lighter dark, centered layout.`,
    },
    {
        name: 'Editorial & Warm',
        css_personality: `Off-white (#fafaf9) background. Serif headings (Georgia/serif) + sans body.
Generous whitespace (section padding 120px). Thin hairline borders (1px solid #e5e7eb).
Warm accent color pops only on key elements. Asymmetric editorial grid layouts.
Photo-editorial feel: large image placeholder boxes (aspect-ratio: 16/9, gradient fill).`,
        layout_patterns: `HOME: Asymmetric hero — oversized serif headline left (80% width), thin vertical rule,
small eyebrow label above. Background: large off-white, one color block behind headline.
Wide image placeholder below fold (full-width, 400px tall, gradient).
Features: 2-col alternating layout (text left, visual block right; then swap).
Process steps: numbered 1-2-3-4 in thin left-border list, step title + 2-sentence description.
Pull quote section: large italic quote between two thin horizontal rules.
Minimal footer: centered, just logo + links + copyright, lots of whitespace.`,
    },
];

// ── HERO IMAGE ─────────────────────────────────────────────────────────────
// Hero image via Gemini Imagen 4 (gpt-image-1 skipped — OpenAI billing exhausted)

async function generateHeroImage(businessName, businessType, palette, designStyle) {
    const prompt = `Professional website hero background for ${businessType} business "${businessName}".
Abstract composition, no text, no faces. Photorealistic. ${designStyle.css_personality.split('.')[0]}.
Color palette inspiration: ${palette.primary}, ${palette.secondary}, ${palette.accent}.
Wide landscape 16:9. Suitable as a full-width website hero background.`;

    // Gemini Imagen 4 (OpenAI billing exhausted)
    const imagenUrl = `https://generativelanguage.googleapis.com/v1beta/models/imagen-4.0-fast-generate-001:predict?key=${process.env.GEMINI_API_KEY}`;
    const resp = await axios.post(imagenUrl, {
        instances: [{ prompt }],
        parameters: { sampleCount: 1, aspectRatio: '16:9', outputMimeType: 'image/jpeg' },
    }, { timeout: 90000 });

    const b64 = resp.data.predictions?.[0]?.bytesBase64Encoded;
    if (!b64) throw new Error('No image data from Gemini Imagen either');
    console.log(`      Hero image via Gemini Imagen 4.`);
    return b64;
}

// ── PALETTE SUGGESTION ─────────────────────────────────────────────────────

async function suggestPalettes(analysis, existingColors) {
    // Filter: skip transparent/near-white/near-black — keep the meaningful brand colors
    const colorHints = (existingColors || [])
        .filter(c => !c.includes('rgba(0') && c !== 'rgb(255, 255, 255)' && c !== 'rgb(0, 0, 0)' && c !== 'rgb(238, 238, 238)')
        .slice(0, 15)
        .join(', ');

    const resp = await axios.post(
        'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
        {
            model: 'gemini-flash-latest',
            max_tokens: 800,
            messages: [{
                role: 'user',
                content: `Suggest 3 distinct color palettes for a ${analysis.businessType} website redesign.
Tone: ${analysis.tone}. Color personality: ${analysis.colorPersonality || 'professional'}.
EXISTING SITE COLORS extracted from the current site's CSS: ${colorHints || 'none detected'}.
Derive palettes that feel like improved evolutions of those colors — preserve the brand feel while making it more modern.
Each palette must be meaningfully different from the others (not just brightness variations).
Return ONLY valid JSON:
{"palettes":[{"name":"...","concept":"...","primary":"#hex","secondary":"#hex","accent":"#hex","background":"#hex","surface":"#hex","text":"#hex","dark":"#hex"}]}`,
            }],
        },
        {
            headers: {
                'Authorization': `Bearer ${process.env.GEMINI_API_KEY}`,
                'Content-Type': 'application/json',
            },
            timeout: 30000,
        }
    );
    const raw = resp.data.choices[0].message.content?.trim() || '';
    const text = raw.replace(/^```json\n?/, '').replace(/\n?```$/, '');
    const parsed = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
    if (!parsed.palettes || parsed.palettes.length < 3) throw new Error('Not enough palettes in response');
    return parsed.palettes;
}

// ── STEP 1: SITEMAP (two-phase, one small call + one per page) ────────────

const SECTION_LIBRARY = `
hero              → { eyebrow, headline, subheadline, primary_cta, secondary_cta, stat1{value,label}, stat2{value,label}, stat3{value,label} }
page_hero         → { eyebrow, headline, body }
trust_strip       → { label, items:["emoji + label",...5] }
features_grid     → { eyebrow, headline, items:[{icon,title,body:"~20 words"},...3] }
stats_band        → { items:[{value,suffix,label},...4] }
testimonials_grid → { eyebrow, headline, items:[{quote:"~30 words",author,role,rating:5},...3] }
cta_strip         → { headline, body:"~20 words", primary_cta, secondary_cta }
services_cards    → { eyebrow, headline, items:[{icon,title,body:"~40 words",cta},...3-6] }
menu_grid         → { eyebrow, headline, categories:[{name,items:[{name,description:"~15 words",price},...3-5]},...3-4] }
portfolio_grid    → { eyebrow, headline, items:[{title,category,description:"~20 words"},...6] }
process_steps     → { eyebrow, headline, steps:[{number:"01",title,body:"~25 words"},...3-4] }
team_grid         → { eyebrow, headline, members:[{name,role,bio:"~20 words",initial},...3] }
story_split       → { eyebrow, headline, body_p1:"~60 words", body_p2:"~40 words", founded_label, founded_value, values:[{icon,title,body:"~10 words"},...4] }
faq_accordion     → { eyebrow, headline, items:[{q,a:"~30 words"},...4] }
gallery_grid      → { eyebrow, headline, items:[{caption:"~10 words",category},...6] }
pricing_cards     → { eyebrow, headline, items:[{name,price,period,features:["...",...4],cta,featured:bool},...3] }
contact_split     → { form_headline, form_fields:["..."], submit_cta, info_headline, address, email, phone, hours, map_placeholder:true }
hours_info        → { headline, schedule:[{day,hours},...7], note:"~20 words" }`;

// Phase A: map crawled pages to the new site's page list — tiny output (~300 tokens)
// crawledPages comes from the crawler: [{ navLabel, path, title, headings, paragraphs, ctas }]
async function decidePagesStructure(analysis, crawledPages) {
    const crawledSummary = crawledPages
        .map(p => `  - "${p.navLabel}" (${p.path}): ${p.headings.slice(0, 3).join(' | ') || 'no headings'}`)
        .join('\n');

    const resp = await callClaude({
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        system: 'You are a JSON-only responder. Output raw JSON. No markdown. No explanation.',
        messages: [{
            role: 'user',
            content: `The crawler found these existing pages on ${analysis.businessName}'s site:
${crawledSummary}

Map them to a clean page structure for the redesign. Rules:
- Home is always first (id:"index", filename:"index.html")
- Contact is always last (id:"contact", filename:"contact.html") — add it even if missing
- Keep a page if it has real content; merge or drop thin/redundant ones
- Rename to fit the business type if generic (e.g. salon→"Treatments" not "Services")
- Add sourcePath matching the crawled path so we know which content belongs to each page; null for new pages

Return JSON:
{"pages":[{"id":"kebab-id","filename":"kebab.html","title":"Title","navLabel":"Label","purpose":"one sentence","sourcePath":"/path-or-null"}]}`,
        }],
    });
    return extractJSON(resp.content[0].text).pages;
}

// Phase B: generate sections for ONE page — uses crawled content as grounding
async function generatePageSections(page, allPages, analysis, crawledContent) {
    const isHome = page.id === 'index';
    const isContact = page.id === 'contact';

    const sectionRequirement = isHome
        ? 'REQUIRED SECTIONS in this order: hero, trust_strip, features_grid, stats_band, testimonials_grid, cta_strip'
        : isContact
            ? 'REQUIRED SECTIONS: page_hero, contact_split'
            : `Choose 3–4 sections from the library that best serve this page's purpose: "${page.purpose}"`;

    const textPrompt = `Design sections for the "${page.title}" page of ${analysis.businessName} (${analysis.businessType}).
Page purpose: ${page.purpose}
${crawledContent && (crawledContent.headings.length > 0 || crawledContent.paragraphs.length > 0) ? `EXISTING PAGE CONTENT:
Headings: ${crawledContent.headings.join(' | ')}
Key paragraphs: ${crawledContent.paragraphs.slice(0, 5).join(' | ')}
CTAs: ${crawledContent.ctas.join(', ')}` : crawledContent?.screenshot ? 'The page is mostly images — see the screenshot attached. Identify what content is there and design sections accordingly.' : ''}

${sectionRequirement}

SECTION LIBRARY:${SECTION_LIBRARY}

Use CONTENT ABSTRACTIONS — word counts and structure only, not actual copy.

Return JSON (this page only):
{"id":"${page.id}","filename":"${page.filename}","title":"${page.title}","navLabel":"${page.navLabel}","sections":[{"id":"section-id","type":"type_name","content":{...}}]}`;

    // If the crawled page was thin (image-heavy), attach its screenshot for vision
    const messageContent = crawledContent?.screenshot
        ? [
            { type: 'text', text: textPrompt },
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: crawledContent.screenshot } },
          ]
        : textPrompt;

    const resp = await callClaude({
        model: 'claude-sonnet-4-6',
        max_tokens: 2048,
        system: 'You are a JSON-only responder. Output raw JSON. No markdown. No explanation.',
        messages: [{ role: 'user', content: messageContent }],
    });
    return extractJSON(resp.content[0].text);
}

// Orchestrator: map crawled pages → decide structure → design sections per page
async function generateSitemap(analysis, crawlData) {
    const crawledPages = crawlData.crawledPages || [{
        navLabel: 'Home', path: '/',
        headings: crawlData.headings || [],
        paragraphs: (crawlData.paragraphs || []).filter(t => t.length > 30),
        ctas: crawlData.ctas || [],
    }];

    console.log(`    Crawled pages: ${crawledPages.map(p => p.navLabel).join(', ')}`);
    console.log('    Mapping to new page structure...');
    const pageList = await decidePagesStructure(analysis, crawledPages);
    console.log(`    Pages: ${pageList.map(p => p.title).join(', ')}`);

    const fullPages = [];
    for (const page of pageList) {
        // Match back to crawled content by sourcePath
        const crawledContent = crawledPages.find(cp =>
            cp.path === page.sourcePath ||
            cp.navLabel?.toLowerCase() === page.navLabel?.toLowerCase()
        ) || null;
        console.log(`    Designing sections: ${page.title}${crawledContent ? ' (with crawled content)' : ''}...`);
        const fullPage = await generatePageSections(page, pageList, analysis, crawledContent);
        fullPages.push(fullPage);
    }
    return { pages: fullPages };
}

// ── STEP 1.5: CONTENT ENRICHMENT ──────────────────────────────────────────

// Claude Haiku call fills all section text across all pages.
// Returns the same sitemap structure with abstract descriptions replaced by real copy.
// Saved to content.json so it can be reused or inspected independently.
async function enrichContent(sitemap, analysis, crawlData) {
    // Enrich one page at a time to avoid JSON truncation on large sitemaps.
    // Each page call is small enough that Haiku reliably returns valid JSON.
    const rawContent = [
        crawlData.headings?.slice(0, 10).join(' | '),
        crawlData.ctas?.slice(0, 6).join(' | '),
        (crawlData.paragraphs || []).slice(0, 3).join(' '),
    ].filter(Boolean).join('\n');

    const businessCtx = `BUSINESS: ${analysis.businessName}
Location: ${analysis.location || 'not specified'}
Offerings: ${analysis.primaryOfferings.join(', ')}
Competitive advantage: ${analysis.competitiveAdvantage}
Tone: ${analysis.tone}
Target audience: ${analysis.targetAudience}

EXISTING SITE CONTENT (source material — improve and adapt, do not copy verbatim):
${rawContent}`;

    const enrichedPages = await Promise.all(sitemap.pages.map(async (page) => {
        const resp_enrich = await claude.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 4000,
            system: 'You are a professional copywriter. Return ONLY valid JSON. No markdown. No explanation.',
            messages: [{
                role: 'user',
                content: `Write real, polished website copy for this single page of a ${analysis.businessType} website.

${businessCtx}

PAGE TO ENRICH:
${JSON.stringify(page, null, 2)}

Descriptions to replace look like: "bold 7-word main value prop headline", "30-word testimonial about a specific benefit", "emoji + 3-word label", "relevant number", etc.

Rules:
- Headlines: punchy, specific, benefit-focused — no filler words
- Body/subheadline: natural, human, not generic marketing speak
- Testimonials: specific and believable, mention concrete outcomes, use real-sounding names
- CTAs: action-oriented and specific ("Book a Free Consultation", "View Our Menu", "Get a Quote")
- Stats: realistic numbers that fit the business type (do not invent absurd figures)
- Emojis: pick the single most relevant emoji per item
- Do NOT change JSON keys, arrays, structure, or non-abstract values (like "map_placeholder": true)
- Every field that contains an abstract description must be replaced with actual text

Return the exact same JSON structure for this page with every abstract description replaced by real content.`,
            }],
        });

        const text = resp_enrich.content[0].text.trim()
            .replace(/^```json\n?/, '').replace(/\n?```$/, '').trim();
        return JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
    }));

    return { ...sitemap, pages: enrichedPages };
}

// ── STEP 2: DESIGN SYSTEM CSS ──────────────────────────────────────────────

async function generateDesignSystem(analysis, palette, designStyle, uxIntel) {
    const intelBlock = [
        uxIntel?.color ? `INDUSTRY COLOR INTELLIGENCE:\n${uxIntel.color}` : '',
        uxIntel?.typography ? `TYPOGRAPHY INTELLIGENCE:\n${uxIntel.typography}` : '',
        uxIntel?.style ? `UI STYLE INTELLIGENCE:\n${uxIntel.style}` : '',
    ].filter(Boolean).join('\n\n');

    const resp = await callClaude({
        model: 'claude-sonnet-4-6',
        max_tokens: 6000,
        messages: [{
            role: 'user',
            content: `Generate a complete shared CSS design system for a ${analysis.businessType} website.

DESIGN PERSONALITY: ${designStyle.name}
${designStyle.css_personality}

EXACT COLORS to use (override with industry intelligence if it provides better contrast):
--primary: ${palette.primary}
--secondary: ${palette.secondary}
--accent: ${palette.accent}
--bg: ${palette.background}
--surface: ${palette.surface || '#f8fafc'}
--text: ${palette.text}
--dark: ${palette.dark || '#0f172a'}

${intelBlock}

Include these sections in order:

1. :root { all CSS variables — colors, font scale (sm/base/lg/xl/2xl/3xl/4xl), spacing scale, radius, shadows }
2. Reset: *, html, body (font-family: system-ui sans-serif or serif based on style, line-height, color)
3. Typography: h1 (clamp 2.5rem–5rem), h2 (clamp 1.8rem–3rem), h3 (1.4rem), h4, p, strong, a
4. Layout utilities: .container (max-width 1200px, auto margin), .section (padding 96px 0), .section-sm (64px 0), .grid-2, .grid-3, .grid-4, .flex, .flex-center, .flex-between, .flex-col, .gap-sm/md/lg
5. Buttons: .btn (base), .btn-primary (filled accent/primary), .btn-secondary (outline), .btn-ghost (text only), .btn-lg, .btn-sm
6. Card: .card (background surface, radius, shadow, padding 32px, hover lift transition)
7. Badge/eyebrow: .eyebrow (small caps, letter-spacing, accent color, display block, margin-bottom 8px)
8. Navigation: nav (sticky, top 0, z-index 100, blur backdrop), .nav-inner (flex, space-between, height 72px), .nav-logo (bold), .nav-links (flex gap 32px), .nav-cta (button style)
9. Page hero: .page-hero (min-height 320px, gradient or surface bg, centered or left-aligned, padding 80px 0)
10. Form: .form-group (margin-bottom 20px), label, input/textarea/select (full width, border, radius, padding 12px 16px, focus ring in primary color), .form-row (2-col grid)
11. Footer: footer (dark background, light text), .footer-inner (grid 4 cols), .footer-logo, .footer-links (flex col, gap 8px), .footer-bottom (border-top, flex between, small text)
12. Animations: @keyframes fadeUp (translateY 24px → 0, opacity 0 → 1), .animate (opacity 0, translateY 24px), .animate.visible (opacity 1, translateY 0, transition 0.6s ease)

NOTE: Do NOT include @media queries. Responsive CSS is generated separately.

The CSS should produce designs that look premium, modern, and agency-quality.
Return ONLY the raw CSS. No markdown, no backticks, no explanation.`,
        }],
    });
    return resp.content[0].text.trim().replace(/^```css\n?/, '').replace(/\n?```$/, '');
}

// ── STEP 2.5: RESPONSIVE CSS (separate call — keeps base CSS call focused) ─

async function generateResponsiveCSS(designCSS, analysis, palette) {
    const resp = await callClaude({
        model: 'claude-sonnet-4-6',
        max_tokens: 4000,
        messages: [{
            role: 'user',
            content: `Below is the base CSS design system for a ${analysis.businessType} website.
Write ONLY the @media query blocks that make it fully responsive on mobile.

REQUIREMENTS (must address all of these):
- Stack .grid-2, .grid-3, .grid-4 to 1 column
- Hamburger nav: on mobile, show .hamburger button (display:block) and hide .nav-links + .nav-cta by default. When #navLinks has class "open", show it as a vertical dropdown (position:absolute, top:72px, left:0, right:0, flex-direction:column, background = dark var, z-index:200). This is the mobile nav system — do NOT skip this.
- Reduce h1 by ~30% on mobile (use smaller clamp or fixed size)
- Reduce .section padding to 48px 0 (was 96px)
- .container: padding 0 16px
- Hero: center text, reduce min-height to 70vh
- .btn: full width on mobile (width:100%)
- Cards (.card): full width, padding 20px
- Footer .footer-inner: 1 column, gap 24px
- Stats band: 2 columns (grid-template-columns: 1fr 1fr)

OUTPUT: Return ONLY @media (max-width: 768px) { ... } and optionally @media (max-width: 480px) { ... }.
No explanation. No other CSS.

BASE CSS (first 8000 chars):
${designCSS.slice(0, 8000)}`,
        }],
    });
    const llmCSS = resp.content[0].text.trim()
        .replace(/^```css\n?/, '').replace(/\n?```$/, '');

    // Guaranteed hamburger rules — appended after LLM output so they can't be omitted
    const hamburgerCSS = `
/* ── Mobile nav guaranteed rules ── */
@media (max-width: 768px) {
  .hamburger { display: block !important; }
  #navLinks { display: none !important; }
  #navLinks.open {
    display: flex !important;
    flex-direction: column;
    position: absolute;
    top: 72px;
    left: 0;
    right: 0;
    background: var(--dark, #0f172a);
    padding: 16px 24px;
    gap: 12px;
    z-index: 200;
    box-shadow: 0 8px 24px rgba(0,0,0,0.3);
  }
  #navLinks.open a { color: #fff !important; padding: 4px 0; }
  .nav-cta { display: none !important; }
}`;

    return llmCSS + hamburgerCSS;
}

// ── STEP 3: GENERATE ONE PAGE (template + injection) ──────────────────────

async function generatePageHTML(page, sitemap, palette, analysis, designStyle, heroImageBase64, uxIntel, logoUrl, imageUrls) {
    const isHome = page.id === 'index';

    const heroStyle = isHome && heroImageBase64
        ? `background: linear-gradient(rgba(${parseInt(palette.dark?.slice(1,3) || '0f', 16)},${parseInt(palette.dark?.slice(3,5) || '17', 16)},${parseInt(palette.dark?.slice(5,7) || '2a', 16)},0.72), rgba(0,0,0,0.5)), url('./hero.jpg') center/cover no-repeat;`
        : `background: linear-gradient(135deg, ${palette.dark || palette.secondary} 0%, ${palette.primary} 60%, ${palette.accent}44 100%);`;

    // Deterministic nav — LLM copies this verbatim. Logo + hamburger + links + CTA.
    const navLinks = sitemap.pages.map(p =>
        `<a href="${p.filename}" class="${p.id === page.id ? 'active' : ''}">${p.navLabel}</a>`
    ).join('\n      ');
    const logoImg = logoUrl
        ? `<img src="${logoUrl}" alt="${analysis.businessName}" style="height:48px;width:auto;object-fit:contain;display:block;">`
        : `<strong class="nav-logo">${analysis.businessName}</strong>`;
    const navBlock = `<nav>
  <div class="nav-inner container">
    <a href="index.html" style="text-decoration:none;">${logoImg}</a>
    <button class="hamburger" id="menuBtn" aria-label="Abrir menú" style="display:none;background:none;border:none;font-size:1.6rem;cursor:pointer;color:inherit;padding:4px 8px;">☰</button>
    <div class="nav-links" id="navLinks">
      ${navLinks}
    </div>
    <a href="contact.html" class="btn btn-primary btn-sm nav-cta">Contáctanos</a>
  </div>
</nav>`;

    // Build placeholder schema from section structure — LLM uses these paths, not actual content
    const schema = buildPlaceholderSchema(page.sections);
    const schemaBlock = schema.map(p => `  {{${p}}}`).join('\n');

    // Existing site images the LLM can use instead of gradient placeholders
    const imagesBlock = imageUrls && imageUrls.length > 0
        ? `\nEXISTING SITE IMAGES — use these as <img src="..."> instead of gradient placeholders where an image is needed:\n${imageUrls.slice(0, 8).join('\n')}`
        : '';

    const resp = await callClaude({
        model: 'claude-sonnet-4-6',
        max_tokens: 8000,
        messages: [{
            role: 'user',
            content: `Generate a complete HTML TEMPLATE for the "${page.title}" page of ${analysis.businessName}'s website.

THIS IS A TEMPLATE — text fields use placeholders replaced by a script after this call.
Every text field MUST use a placeholder from the PLACEHOLDER SCHEMA below. Do NOT write actual text copy.

DESIGN STYLE: ${designStyle.name}
${designStyle.layout_patterns}

CSS FILES ALREADY LINKED (design.css + responsive.css contain ALL component styles):
design.css already defines: .container, .section, .btn, .btn-primary, .btn-secondary, .btn-ghost,
.card, .eyebrow, nav, .nav-inner, .nav-links, .nav-cta, .page-hero, footer, .footer-inner,
.footer-links, .footer-bottom, .grid-2, .grid-3, .grid-4, .flex, .flex-center, .flex-between,
.gap-sm/md/lg, .animate, @keyframes fadeUp, form elements.

⛔ DO NOT redefine ANY of those classes in a <style> tag. The ONLY allowed <style> content is:
${isHome
    ? `  - Hero background: #hero { ${heroStyle} min-height: 100vh; }`
    : '  - Nothing. Do NOT include a <style> tag for non-home pages.'}

PALETTE: primary=${palette.primary} secondary=${palette.secondary} accent=${palette.accent} dark=${palette.dark || '#0f172a'} bg=${palette.background}

NAV — copy this block EXACTLY as-is into the page (do not modify, do not add extra nav):
${navBlock}
${imagesBlock}

SECTIONS FOR THIS PAGE:
${page.sections.map(s => `- type: ${s.type} (id: ${s.id})`).join('\n')}

PLACEHOLDER SCHEMA — use EXACTLY these paths for ALL text. No other text allowed.
${schemaBlock}

${uxIntel?.ux ? `UX INTELLIGENCE:\n${uxIntel.ux}\n` : ''}
RULES:
1. Placeholders only for text. Nav links and hrefs use the exact HTML given above (not placeholders).
2. Stars: ★★★★★ directly (not a placeholder).
3. Avatar circles: inline div, 48×48px, border-radius 50%, bg primary, white text — use the initial placeholder.
4. Stat numbers: font-size clamp(3rem,6vw,5rem), bold, color accent.
5. Hero (home only): use #hero style from above. Other pages: use class="page-hero".
6. FAQ: <details><summary> elements.
7. Image placeholders: use existing site images above if available; otherwise gradient div.
8. Footer: 4-col dark footer, copyright © ${new Date().getFullYear()} ${analysis.businessName}.
9. IntersectionObserver JS at bottom: adds class "visible" to .animate elements.
10. Do NOT add a mobile nav script — it is injected automatically after generation.
11. Return ONLY complete HTML from <!DOCTYPE html> to </html>. No fences, no explanation.`,
        }],
    });
    const template = resp.content[0].text.trim().replace(/^```html\n?/, '').replace(/\n?```$/, '');

    // Inject real content from sections into template placeholders
    let html = renderTemplate(template, page.sections);

    // Inject deterministic mobile nav script — guaranteed to work regardless of LLM output
    const mobileNavScript = `<script>
(function(){var b=document.getElementById('menuBtn'),n=document.getElementById('navLinks');if(b&&n){b.addEventListener('click',function(){n.classList.toggle('open');b.textContent=n.classList.contains('open')?'✕':'☰';});}})();
</script>`;
    html = html.replace('</body>', mobileNavScript + '\n</body>');
    return html;
}

// ── MAIN EXPORT ────────────────────────────────────────────────────────────

export async function generateDesigns(analysis, crawlData, outputDir) {
    // Palettes
    console.log('  Getting palette suggestions...');
    let palettes;
    try {
        palettes = await suggestPalettes(analysis, crawlData.colors || []);
        if (!palettes || palettes.length < 3) throw new Error('Not enough palettes');
        console.log('  Gemini palettes received.');
    } catch (err) {
        console.log(`  Palette suggestion failed (${err.message}), using defaults.`);
        palettes = DEFAULT_PALETTES;
    }

    // Query ui-ux-pro-max design database for this business type (runs in parallel)
    console.log('  Querying design intelligence (ui-ux-pro-max)...');
    const [uxColorData, uxTypographyData, uxStyleData, uxGuidelinesData] = await Promise.all([
        queryUXPro(analysis.businessType, 'color', 1),
        queryUXPro(`${analysis.tone} ${analysis.businessType}`, 'typography', 2),
        queryUXPro(`${analysis.businessType} ${analysis.tone}`, 'style', 2),
        queryUXPro(analysis.businessType, 'ux', 2),
    ]);
    const uxIntel = { color: uxColorData, typography: uxTypographyData, style: uxStyleData, ux: uxGuidelinesData };
    const hasUXIntel = Object.values(uxIntel).some(v => v.length > 0);
    console.log(`  Design intelligence: ${hasUXIntel ? 'loaded' : 'unavailable (will use defaults)'}`);

    // Sitemap — load from cache or generate
    const sitemapPath = path.join(outputDir, 'sitemap.json');
    let sitemap;
    try {
        sitemap = JSON.parse(await readFile(sitemapPath, 'utf8'));
        console.log(`  Sitemap loaded from cache (${sitemap.pages.length} pages).`);
    } catch {
        console.log('  Generating site architecture (sitemap)...');
        sitemap = await generateSitemap(analysis, crawlData);
        await writeFile(sitemapPath, JSON.stringify(sitemap, null, 2));
        console.log(`  Sitemap: ${sitemap.pages.length} pages — ${sitemap.pages.map(p => p.title).join(', ')}`);
    }

    // Content enrichment — load from cache or generate
    const contentPath = path.join(outputDir, 'content.json');
    let enrichedSitemap = sitemap;
    try {
        enrichedSitemap = JSON.parse(await readFile(contentPath, 'utf8'));
        console.log('  Content loaded from cache (content.json).');
    } catch {
        console.log('  Enriching content (Claude Haiku)...');
        try {
            enrichedSitemap = await enrichContent(sitemap, analysis, crawlData);
            await writeFile(contentPath, JSON.stringify(enrichedSitemap, null, 2));
            console.log('  Content enrichment complete, content.json saved.');
        } catch (err) {
            console.log(`  Content enrichment failed (${err.message?.slice(0, 80)}), using abstract sitemap as fallback.`);
        }
    }

    const designs = [];

    for (let i = 0; i < 3; i++) {
        const palette = { ...DEFAULT_PALETTES[i], ...(palettes[i] || {}) };
        const style = DESIGN_STYLES[i];
        const designDir = path.join(outputDir, `design-${i + 1}`);
        await mkdir(designDir, { recursive: true });

        console.log(`\n  ── Design ${i + 1}/3: ${style.name} ──`);

        // Hero image via Gemini Imagen — skip if already on disk
        let heroImageBase64 = null;
        const heroPath = path.join(designDir, 'hero.jpg');
        try {
            await readFile(heroPath);
            heroImageBase64 = 'cached'; // truthy so ./hero.jpg is referenced in generated HTML
            console.log(`    Hero image cached, skipping.`);
        } catch {
            try {
                console.log(`    Generating hero image (Gemini Imagen)...`);
                heroImageBase64 = await generateHeroImage(analysis.businessName, analysis.businessType, palette, style);
                await writeFile(heroPath, Buffer.from(heroImageBase64, 'base64'));
                console.log(`    Hero image generated.`);
            } catch (err) {
                console.log(`    Hero image failed (${err.message?.slice(0, 80)}), using CSS gradient.`);
            }
        }

        // Design system CSS — skip if already on disk
        const cssPath = path.join(designDir, 'design.css');
        let css;
        try {
            css = await readFile(cssPath, 'utf8');
            console.log(`    CSS cached, skipping.`);
        } catch {
            console.log(`    Generating design system CSS...`);
            css = await generateDesignSystem(analysis, palette, style, uxIntel);
            await writeFile(cssPath, css);
            console.log(`    CSS written (${css.length} bytes).`);
        }

        // Responsive CSS — separate call, separate file (skipped if cached)
        const responsiveCssPath = path.join(designDir, 'responsive.css');
        try {
            await readFile(responsiveCssPath);
            console.log(`    Responsive CSS cached, skipping.`);
        } catch {
            console.log(`    Generating responsive CSS...`);
            const responsiveCss = await generateResponsiveCSS(css, analysis, palette);
            await writeFile(responsiveCssPath, responsiveCss);
            console.log(`    Responsive CSS written (${responsiveCss.length} bytes).`);
        }

        // Per-page HTML — skip pages already on disk
        for (const page of enrichedSitemap.pages) {
            const pagePath = path.join(designDir, page.filename);
            try {
                await readFile(pagePath);
                console.log(`    ${page.filename} cached, skipping.`);
                continue;
            } catch { /* generate */ }
            console.log(`    Generating ${page.title} page...`);
            const useHero = page.id === 'index' ? heroImageBase64 : null;
            const html = await generatePageHTML(page, enrichedSitemap, palette, analysis, style, useHero, uxIntel, crawlData.logoUrl, crawlData.imageUrls);
            await writeFile(pagePath, html);
            console.log(`    ${page.filename} written (${html.length} bytes, divs: ${(html.match(/<div/g) || []).length}).`);
        }

        designs.push({
            index: i + 1,
            name: style.name,
            palette,
            dir: `design-${i + 1}`,
            entryPoint: 'index.html',
            pages: enrichedSitemap.pages.map(p => ({ title: p.title, filename: p.filename })),
        });
    }

    return designs;
}
