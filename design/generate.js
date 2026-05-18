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

// ── GSAP ANIMATION SCRIPT (deterministic, based on section types) ───────────

function buildAnimationScript(page, hasHeroImage) {
    const sectionTypes = new Set(page.sections.map(s => s.type));
    const parts = [];

    // Universal: fade-in all sections on scroll
    parts.push(`
    gsap.utils.toArray('section[id^="section-"]').forEach(function(el) {
        gsap.from(el, {
            opacity: 0, y: 48, duration: 0.85, ease: 'power2.out',
            scrollTrigger: { trigger: el, start: 'top 88%', once: true }
        });
    });`);

    // Hero parallax — only when hero.jpg is present
    if (hasHeroImage) {
        parts.push(`
    var heroEl = document.getElementById('hero');
    if (heroEl) {
        gsap.to(heroEl, {
            backgroundPositionY: '35%', ease: 'none',
            scrollTrigger: { trigger: heroEl, start: 'top top', end: 'bottom top', scrub: 1.5 }
        });
    }`);
    }

    // Stagger card entrance for grid sections
    if (sectionTypes.has('features_grid') || sectionTypes.has('services_cards') || sectionTypes.has('portfolio_grid') || sectionTypes.has('team_grid')) {
        parts.push(`
    ['section-features_grid','section-services_cards','section-portfolio_grid','section-team_grid'].forEach(function(id) {
        var sec = document.getElementById(id);
        if (!sec) return;
        var items = sec.querySelectorAll('.grid-2 > *, .grid-3 > *, .grid-4 > *, .card');
        if (!items.length) return;
        gsap.from(items, {
            opacity: 0, y: 56, scale: 0.96, duration: 0.65, stagger: 0.13, ease: 'power2.out',
            scrollTrigger: { trigger: sec, start: 'top 82%', once: true }
        });
    });`);
    }

    // Story split — text from left, image from right
    if (sectionTypes.has('story_split')) {
        parts.push(`
    var storySec = document.getElementById('section-story_split');
    if (storySec) {
        var cols = storySec.querySelectorAll('.grid-2 > *');
        if (cols.length >= 2) {
            gsap.from(cols[0], { opacity: 0, x: -70, duration: 1, ease: 'power2.out', scrollTrigger: { trigger: storySec, start: 'top 78%', once: true } });
            gsap.from(cols[1], { opacity: 0, x: 70, duration: 1, delay: 0.15, ease: 'power2.out', scrollTrigger: { trigger: storySec, start: 'top 78%', once: true } });
        }
    }`);
    }

    // Testimonials stagger (scale + fade)
    if (sectionTypes.has('testimonials_grid')) {
        parts.push(`
    var testSec = document.getElementById('section-testimonials_grid');
    if (testSec) {
        var items = testSec.querySelectorAll('blockquote, .card, .grid-3 > *');
        gsap.from(items, {
            opacity: 0, y: 36, scale: 0.96, duration: 0.7, stagger: 0.18, ease: 'power2.out',
            scrollTrigger: { trigger: testSec, start: 'top 82%', once: true }
        });
    }`);
    }

    // Process steps sequential left-to-right reveal
    if (sectionTypes.has('process_steps')) {
        parts.push(`
    var procSec = document.getElementById('section-process_steps');
    if (procSec) {
        var steps = procSec.querySelectorAll('.grid-3 > *, .grid-4 > *, [class*="step"]');
        gsap.from(steps, {
            opacity: 0, x: -40, duration: 0.65, stagger: 0.22, ease: 'power1.out',
            scrollTrigger: { trigger: procSec, start: 'top 82%', once: true }
        });
    }`);
    }

    // Counter animation for stats — targets elements with [data-count]
    if (sectionTypes.has('stats_band') || sectionTypes.has('hero')) {
        parts.push(`
    document.querySelectorAll('[data-count]').forEach(function(el) {
        var target = parseFloat(el.getAttribute('data-count').replace(/[^0-9.]/g, ''));
        if (isNaN(target)) return;
        var suffix = el.getAttribute('data-count').replace(/[0-9.]/g, '');
        var obj = { val: 0 };
        gsap.to(obj, {
            val: target, duration: 2.2, ease: 'power1.out',
            onUpdate: function() { el.textContent = Math.round(obj.val).toLocaleString() + suffix; },
            scrollTrigger: { trigger: el, start: 'top 88%', once: true }
        });
    });`);
    }

    // Pricing cards pop-in
    if (sectionTypes.has('pricing_cards')) {
        parts.push(`
    var priceSec = document.getElementById('section-pricing_cards');
    if (priceSec) {
        var cards = priceSec.querySelectorAll('.card, .grid-3 > *');
        gsap.from(cards, {
            opacity: 0, y: 48, scale: 0.93, duration: 0.7, stagger: 0.15, ease: 'back.out(1.4)',
            scrollTrigger: { trigger: priceSec, start: 'top 82%', once: true }
        });
    }`);
    }

    // FAQ accordion items cascade
    if (sectionTypes.has('faq_accordion')) {
        parts.push(`
    var faqSec = document.getElementById('section-faq_accordion');
    if (faqSec) {
        var items = faqSec.querySelectorAll('details');
        gsap.from(items, {
            opacity: 0, y: 20, duration: 0.5, stagger: 0.1, ease: 'power1.out',
            scrollTrigger: { trigger: faqSec, start: 'top 85%', once: true }
        });
    }`);
    }

    return `<script>
(function() {
    if (typeof gsap === 'undefined' || typeof ScrollTrigger === 'undefined') return;
    gsap.registerPlugin(ScrollTrigger);
    window.addEventListener('load', function() {
${parts.join('\n')}
    });
})();
</script>`;
}

// ── GALLERY SECTION (existing site images + dialog lightbox) ────────────────

function buildGallerySection(imageUrls, analysis) {
    if (!imageUrls || imageUrls.length < 4) return '';
    const imgs = imageUrls.slice(0, 12);
    const thumbs = imgs.map((url, i) =>
        `        <button class="gallery-thumb" onclick="openGallery(${i})" aria-label="Ver imagen ${i + 1}">
            <img src="${url}" alt="${analysis.businessName}" loading="lazy">
        </button>`
    ).join('\n');
    const dialogImgs = imgs.map((url, i) =>
        `    <img src="${url}" class="gallery-dialog-img${i === 0 ? ' active' : ''}" data-idx="${i}" alt="Imagen ${i + 1}">`
    ).join('\n');

    return `
<section class="section gallery-section" id="section-gallery">
    <div class="container">
        <p class="eyebrow">Nuestros proyectos</p>
        <h2>Galería</h2>
        <div class="gallery-grid">
${thumbs}
        </div>
    </div>
</section>

<dialog id="galleryDialog" class="gallery-dialog">
    <button class="gallery-close" onclick="closeGallery()" aria-label="Cerrar">&#x2715;</button>
    <button class="gallery-prev" onclick="prevImg()" aria-label="Anterior">&#8249;</button>
${dialogImgs}
    <button class="gallery-next" onclick="nextImg()" aria-label="Siguiente">&#8250;</button>
</dialog>

<style>
.gallery-section { overflow: hidden; }
.gallery-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 220px), 1fr)); gap: 12px; margin-top: 40px; }
.gallery-thumb { border: none; padding: 0; cursor: pointer; border-radius: 10px; overflow: hidden; aspect-ratio: 4 / 3; background: var(--surface, #f1f5f9); transition: box-shadow 0.25s ease, transform 0.25s ease; }
.gallery-thumb:hover { box-shadow: 0 10px 30px rgba(0,0,0,0.18); transform: translateY(-3px); }
.gallery-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; transition: transform 0.4s ease; }
.gallery-thumb:hover img { transform: scale(1.07); }
.gallery-dialog { border: none; border-radius: 14px; padding: 0; max-width: 90vw; max-height: 90vh; background: #111; overflow: visible; box-shadow: 0 32px 96px rgba(0,0,0,0.75); }
.gallery-dialog::backdrop { background: rgba(0,0,0,0.88); backdrop-filter: blur(4px); }
.gallery-dialog-img { display: none; max-width: 85vw; max-height: 82vh; object-fit: contain; border-radius: 10px; vertical-align: middle; }
.gallery-dialog-img.active { display: block; }
.gallery-close { position: absolute; top: -16px; right: -16px; background: #fff; border: none; color: #111; font-size: 1rem; font-weight: 700; cursor: pointer; border-radius: 50%; width: 36px; height: 36px; line-height: 36px; text-align: center; z-index: 10; box-shadow: 0 4px 16px rgba(0,0,0,0.3); }
.gallery-prev, .gallery-next { position: absolute; top: 50%; transform: translateY(-50%); background: rgba(255,255,255,0.15); border: none; color: #fff; font-size: 2.4rem; cursor: pointer; border-radius: 50%; width: 52px; height: 52px; display: flex; align-items: center; justify-content: center; transition: background 0.2s; z-index: 10; }
.gallery-prev:hover, .gallery-next:hover { background: rgba(255,255,255,0.3); }
.gallery-prev { left: -26px; }
.gallery-next { right: -26px; }
</style>

<script>
(function() {
    var dlg = document.getElementById('galleryDialog');
    var imgs = dlg ? dlg.querySelectorAll('.gallery-dialog-img') : [];
    var cur = 0;
    function show(i) { cur = (i + imgs.length) % imgs.length; imgs.forEach(function(img, j) { img.classList.toggle('active', j === cur); }); }
    window.openGallery = function(i) { show(i); dlg && dlg.showModal(); };
    window.closeGallery = function() { dlg && dlg.close(); };
    window.prevImg = function() { show(cur - 1); };
    window.nextImg = function() { show(cur + 1); };
    dlg && dlg.addEventListener('click', function(e) { if (e.target === dlg) closeGallery(); });
    document.addEventListener('keydown', function(e) {
        if (!dlg || !dlg.open) return;
        if (e.key === 'ArrowRight') nextImg();
        else if (e.key === 'ArrowLeft') prevImg();
        else if (e.key === 'Escape') closeGallery();
    });
})();
</script>`;
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
        name: 'Split Corporate',
        css_personality: `White base. Bold sans-serif headlines. No cards for features — use horizontal alternating rows.
Sticky nav: white bg, box-shadow 0 1px 0 #e2e8f0, height 72px. Buttons: sharp (border-radius 4px), solid fill.
Hero: 55/45 split — left column has text, right column is the hero.jpg (object-fit:cover, full height).
If no hero image: full-width gradient (primary → dark), text centered.
Stats: giant numbers (6rem) on a dark band with thin accent-color top border.
Testimonials: left-border 4px accent, italic quote, no cards, 2-col layout.
Section labels: eyebrow uppercase tracking-widest 11px, accent color, margin-bottom 8px.
No emojis. No decorative icons. Numbers and typography carry the visual weight.`,
        layout_patterns: `HOME:
- Hero: <div style="display:grid;grid-template-columns:55% 45%;min-height:100vh;"> Left: dark bg, centered content (eyebrow + h1 clamp(3rem,5vw,4.5rem) + subhead + 2 buttons + 3 inline stats). Right: <img src="./hero.jpg" style="width:100%;height:100%;object-fit:cover;">. If no hero.jpg: full-width gradient hero centered.
- Trust strip: white bg, max-width container, 5 text labels in a row separated by thin vertical rules (1px solid #e2e8f0), font-size 0.85rem uppercase letter-spacing.
- Features: 3 alternating rows. Each row: left text (eyebrow + h3 + 2-sentence body + text link) on white; right: solid accent-color block (border-radius 0) with 1 key number or short quote centered in white. Odd rows swap sides.
- Stats: dark bg band, 4 numbers (6rem font, accent color), label below in small caps.
- Testimonials: 2-col, each a blockquote — 4px left border accent, italic 1.2rem quote, author name bold, role small gray.
- CTA: primary-color bg, centered h2 + subhead + 1 button white outline.
- Footer: dark, 4-col grid.

INNER PAGES:
- Page hero: left-aligned, 40vh, dark bg, eyebrow + h1 + short body.
- Content: alternating left-label / right-content rows with thin bottom border (like a definition list at scale).`,
    },
    {
        name: 'Dark Statement',
        css_personality: `Near-black base (var(--dark)). Crisp white text. Typography is the hero.
Nav: fully transparent on scroll-top, dark solid after scroll. Logo white. Links white.
Hero headline: clamp(4rem,8vw,7rem). Key words wrapped in <span style="color:var(--accent)"> for color emphasis.
Sections alternate: dark → slightly lighter dark (background: rgba(255,255,255,0.04)) for rhythm.
Buttons: outline style (border 2px solid accent, transparent bg, accent text) on dark; filled on light sections.
No cards, no emojis. Each feature is a full-width dark row with a large number and short text block.
Testimonials: centered single large italic quote, decorative open-quote character (") 6rem accent color above.
Light breakout section: pure white bg, dark text — used for stats or CTA to create strong contrast break.`,
        layout_patterns: `HOME:
- Hero: full-viewport dark bg. Centered. Large eyebrow (uppercase 12px white/50%). h1 with accent-colored key word. Subhead 1.2rem white/70%. 2 buttons (outline + ghost). No hero image in viewport — hero.jpg used as subtle 10% opacity background texture if available.
- Features: NO grid. 3-4 stacked full-width rows. Each: left column has a large counter (01 / 02 / 03) in 5rem accent color; right column has h3 + body paragraph. Thin horizontal rule between rows.
- Light break section: white bg, 4 stats in a row, dark text on white.
- Testimonials: centered on dark, decorative " character (font-size 8rem, accent, opacity 0.3, position absolute), below it: italic quote 1.4rem white, then name + role in small text.
- CTA: gradient bg (primary to secondary), centered h2 + body + 1 large button.
- Footer: slightly lighter dark, centered — logo, links in a single row, copyright.

INNER PAGES:
- Dark page hero: full-width dark, centered, h1 + eyebrow.
- Content sections: dark alternating rows, clean typography.`,
    },
    {
        name: 'Editorial Minimal',
        css_personality: `Off-white (#fafaf9) background. Georgia/serif for headlines, system-ui for body.
Maximum whitespace. Section padding 120px 0. NO cards anywhere.
Nav: minimal — just logo and 4 text links, no button, no background, only a thin 1px bottom border.
Hero: pure typography. No image. Oversized serif headline (clamp 4.5rem,9vw,8rem), full width.
Features rendered as a numbered table: thin horizontal rules, large left counter, text right.
Testimonials: full-width centered, large quotation marks as decoration, thin rules above/below.
All body text max-width 680px, centered or left-aligned, comfortable line-height 1.8.
Accent color used sparingly: only on links, counters, and one highlight element per section.
No emojis. No icons. Decoration comes from typography scale and white space.`,
        layout_patterns: `HOME:
- Hero: off-white full-width. Eyebrow (uppercase 11px letter-spacing 0.15em accent). h1 serif, spanning 90% width, clamp(5rem,9vw,8rem), dark color. Below: 2-col (intro paragraph left, 3 key stats right — each stat: large number serif 3rem + label in small caps). Hero.jpg if present: placed below fold as a full-width image (aspect-ratio:16/9, object-fit:cover), not as hero bg.
- Features/services: numbered rows — "01", "02", "03" in serif 4rem accent left; title h3 + 2-sentence body right; thin 1px #e5e7eb rule separating each. No cards, no grids.
- Testimonials: centered, max-width 680px. Open " in serif 6rem accent opacity 0.25. Italic quote 1.3rem. Thin rule. Author name + role small caps.
- CTA: off-white with a thin full-width border-top. Centered. h2 serif + short body + 1 button.
- Footer: centered, generous padding. Logo + horizontal link list + copyright. Nothing else.

INNER PAGES:
- Page hero: typography only, off-white, eyebrow + h1 serif, left-aligned, max-width.
- Content: editorial column (max-width 720px, centered), large readable type.`,
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
trust_strip       → { label, items:["short text label",...5] }
features_grid     → { eyebrow, headline, items:[{title,body:"~20 words"},...3] }
stats_band        → { items:[{value,suffix,label},...4] }
testimonials_grid → { eyebrow, headline, items:[{quote:"~30 words",author,role},...3] }
cta_strip         → { headline, body:"~20 words", primary_cta, secondary_cta }
services_cards    → { eyebrow, headline, items:[{title,body:"~40 words",cta},...3-6] }
menu_grid         → { eyebrow, headline, categories:[{name,items:[{name,description:"~15 words",price},...3-5]},...3-4] }
portfolio_grid    → { eyebrow, headline, items:[{title,category,description:"~20 words"},...6] }
process_steps     → { eyebrow, headline, steps:[{number:"01",title,body:"~25 words"},...3-4] }
team_grid         → { eyebrow, headline, members:[{name,role,bio:"~20 words",initial},...3] }
story_split       → { eyebrow, headline, body_p1:"~60 words", body_p2:"~40 words", founded_label, founded_value, values:[{title,body:"~10 words"},...4] }
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
- NO emojis anywhere. trust_strip items are short text labels (3–5 words). features/services have no icon field.
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
4. Layout utilities: .container (max-width 1200px, auto margin, padding 0 24px), .section (padding 96px 0), .section-sm (64px 0), .flex, .flex-center, .flex-between, .flex-col, .gap-sm/md/lg. Responsive grids using auto-fit: .grid-2 { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,480px),1fr)); gap:var(--gap-md); } .grid-3 { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr)); gap:var(--gap-md); } .grid-4 { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr)); gap:var(--gap-md); }
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
    const baseCss = resp.content[0].text.trim().replace(/^```css\n?/, '').replace(/\n?```$/, '');

    // Deterministic microinteraction CSS — appended so it's always present
    const microCSS = `

/* ── Microinteractions ── */
.card { transition: transform 0.25s ease, box-shadow 0.25s ease; }
.card:hover { transform: translateY(-5px); box-shadow: 0 20px 48px rgba(0,0,0,0.13); }
.btn { transition: transform 0.15s ease, background 0.2s ease, box-shadow 0.2s ease, color 0.2s ease; }
.btn:hover { transform: translateY(-2px); box-shadow: 0 8px 24px rgba(0,0,0,0.18); }
.gallery-thumb { transition: transform 0.25s ease, box-shadow 0.25s ease; }
a:not(.btn):not([class*="logo"]):not(.gallery-thumb) { transition: opacity 0.15s ease; }
a:not(.btn):not([class*="logo"]):not(.gallery-thumb):hover { opacity: 0.72; }
input:focus, textarea:focus, select:focus { outline: none; box-shadow: 0 0 0 3px rgba(37,99,235,0.25); transition: box-shadow 0.2s; }
details summary { cursor: pointer; user-select: none; transition: color 0.2s; }
details summary:hover { color: var(--accent, #f59e0b); }`;

    return baseCss + microCSS;
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
${page.sections.map(s => `- type: ${s.type} → must render as <section id="section-${s.type}" class="section">`).join('\n')}

PLACEHOLDER SCHEMA — use EXACTLY these paths for ALL text. No other text allowed.
${schemaBlock}

${uxIntel?.ux ? `UX INTELLIGENCE:\n${uxIntel.ux}\n` : ''}
RULES:
1. Placeholders only for text. Nav links and hrefs use the exact HTML given above (not placeholders).
2. NO emojis anywhere in the HTML. No decorative icons. Use numbers, typography, and CSS for visual interest.
3. Stars: ★★★★★ directly (not a placeholder) — only in testimonials.
4. Avatar circles: inline div, 48×48px, border-radius 50%, bg primary, white text — use the initial placeholder.
5. Stat numbers: font-size clamp(3rem,6vw,5rem), bold, color accent.
6. Hero (home only): use #hero style from above. Other pages: use class="page-hero".
7. FAQ: <details><summary> elements.
8. Images: use existing site images if provided above; otherwise a gradient div (aspect-ratio:16/9).
9. Footer: dark footer, copyright © ${new Date().getFullYear()} ${analysis.businessName}.
10. Do NOT add any scroll animation JS — GSAP ScrollTrigger is injected automatically.
11. Do NOT add mobile nav script — injected automatically. Do NOT add hamburger JS.
12. Stats that are numbers: wrap the value in <span data-count="VALUE">VALUE</span> so counters animate (e.g. <span data-count="150">150</span>+).
13. Return ONLY complete HTML from <!DOCTYPE html> to </html>. No fences, no explanation.`,
        }],
    });
    const template = resp.content[0].text.trim().replace(/^```html\n?/, '').replace(/\n?```$/, '');

    // Inject real content from sections into template placeholders
    let html = renderTemplate(template, page.sections);

    // ── Inject GSAP + ScrollTrigger CDN ──────────────────────────────────────
    const gsapCDN = `<script src="https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.5/gsap.min.js" defer></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.5/ScrollTrigger.min.js" defer></script>`;
    html = html.replace('</head>', gsapCDN + '\n</head>');

    // ── Gallery section (home page only, if crawled images available) ─────────
    if (isHome && imageUrls && imageUrls.length >= 4) {
        const galleryHtml = buildGallerySection(imageUrls, analysis);
        // Insert before footer so it sits near the end of main content
        html = html.replace(/<footer[\s>]/, galleryHtml + '\n<footer ');
    }

    // ── GSAP animation script (deterministic, based on section types) ─────────
    const animScript = buildAnimationScript(page, !!heroImageBase64);
    html = html.replace('</body>', animScript + '\n</body>');

    // ── Mobile nav script (deterministic) ────────────────────────────────────
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
