import { chromium } from 'playwright';

// Lightweight per-page extraction — headings, paragraphs, CTAs only
async function extractPageContent(page) {
    return page.evaluate(() => {
        const getText = sel => [...document.querySelectorAll(sel)]
            .map(el => el.innerText?.trim()).filter(Boolean);
        return {
            url: location.href,
            title: document.title,
            headings: getText('h1,h2,h3').slice(0, 12),
            paragraphs: getText('p').filter(t => t.length > 30).slice(0, 15),
            ctas: getText('button,.btn,[class*="cta"],[class*="button"]').slice(0, 8),
        };
    });
}

export async function crawlSite(url) {
    const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage();

    await page.setViewportSize({ width: 1440, height: 900 });

    try {
        await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    } catch {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    }

    await page.waitForTimeout(2000);

    // Full homepage extraction (unchanged from original)
    const data = await page.evaluate(() => {
        const getText = (sel) => [...document.querySelectorAll(sel)]
            .map(el => el.innerText?.trim()).filter(Boolean);

        const colors = new Set();
        for (const sheet of document.styleSheets) {
            try {
                for (const rule of sheet.cssRules || []) {
                    const text = rule.cssText || '';
                    const matches = text.match(/#[0-9a-fA-F]{3,6}|rgb\([^)]+\)|rgba\([^)]+\)/g) || [];
                    matches.forEach(c => colors.add(c));
                }
            } catch {}
        }
        document.querySelectorAll('[style]').forEach(el => {
            const matches = el.getAttribute('style')?.match(/#[0-9a-fA-F]{3,6}|rgb\([^)]+\)/g) || [];
            matches.forEach(c => colors.add(c));
        });

        const logoEl = document.querySelector(
            'img[src*="logo"], img[alt*="logo" i], img[class*="logo" i], header img, .header img, nav img'
        );
        const logoUrl = logoEl ? new URL(logoEl.src, location.href).href : null;

        const fonts = new Set();
        document.querySelectorAll('*').forEach(el => {
            const f = getComputedStyle(el).fontFamily;
            if (f) fonts.add(f.split(',')[0].replace(/["']/g, '').trim());
        });

        const navLinks = [...document.querySelectorAll('nav a, header a')]
            .map(a => ({ text: a.innerText?.trim(), href: a.href }))
            .filter(a => a.text && a.href);

        const socialPatterns = ['facebook', 'twitter', 'instagram', 'linkedin', 'youtube', 'tiktok'];
        const socialLinks = [...document.querySelectorAll('a[href]')]
            .map(a => a.href)
            .filter(href => socialPatterns.some(p => href.includes(p)));

        const headings = getText('h1, h2, h3').slice(0, 30);
        const paragraphs = getText('p').slice(0, 50);
        const footerText = getText('footer, .footer').join(' ').slice(0, 500);
        const metaDesc = document.querySelector('meta[name="description"]')?.content || '';
        const title = document.title;
        const ctas = getText('button, .btn, [class*="cta"], [class*="button"]').slice(0, 10);
        const forms = [...document.querySelectorAll('form')].map(f => ({
            action: f.action,
            fields: [...f.querySelectorAll('input, select, textarea')].map(i => i.name || i.placeholder || i.type)
        }));
        const sections = [...document.querySelectorAll('section, [class*="section"], main > div')]
            .map(el => ({
                id: el.id,
                classes: el.className,
                heading: el.querySelector('h1, h2, h3')?.innerText?.trim() || ''
            }))
            .filter(s => s.id || s.heading).slice(0, 20);

        return {
            url: location.href, title, metaDesc, headings, paragraphs,
            navLinks, socialLinks, footerText, ctas, forms, sections,
            colors: [...colors].slice(0, 50),
            fonts: [...fonts].slice(0, 10),
            logoUrl,
        };
    });

    const screenshotBuffer = await page.screenshot({ fullPage: true });

    // ── Multi-page crawl ───────────────────────────────────────────────────
    // Build crawledPages starting with the homepage
    const crawledPages = [{
        url: data.url,
        path: new URL(data.url).pathname || '/',
        navLabel: 'Home',
        title: data.title,
        headings: data.headings.slice(0, 12),
        paragraphs: data.paragraphs.filter(t => t.length > 30).slice(0, 15),
        ctas: data.ctas,
    }];

    const baseOrigin = new URL(data.url).origin;
    const seenUrls = new Set([data.url]);

    // Filter nav links to unique internal pages only
    const internalLinks = data.navLinks
        .filter(link => {
            try {
                const u = new URL(link.href);
                return (
                    u.origin === baseOrigin &&
                    !u.hash &&
                    !link.href.match(/\.(pdf|jpg|jpeg|png|gif|svg|zip|docx?)$/i)
                );
            } catch { return false; }
        })
        .filter((link, idx, arr) => arr.findIndex(l => l.href === link.href) === idx)
        .filter(link => !seenUrls.has(link.href))
        .slice(0, 5); // cap at 5 inner pages

    for (const link of internalLinks) {
        if (seenUrls.has(link.href)) continue;
        seenUrls.add(link.href);
        try {
            await page.goto(link.href, { waitUntil: 'domcontentloaded', timeout: 15000 });
            await page.waitForTimeout(800);
            const content = await extractPageContent(page);

            // If the page is thin (mostly images, minimal text), take a screenshot
            // so the design step can use vision to understand what's there
            const isThin = content.headings.length < 2 && content.paragraphs.length < 2;
            let screenshot = null;
            if (isThin) {
                const buf = await page.screenshot({
                    type: 'jpeg', quality: 50,
                    clip: { x: 0, y: 0, width: 1440, height: 900 },
                });
                screenshot = buf.toString('base64');
                console.log(`  Thin page detected (${link.text}), screenshot captured for vision.`);
            }

            crawledPages.push({
                ...content,
                path: new URL(link.href).pathname,
                navLabel: link.text,
                screenshot, // null for normal pages, base64 JPEG for thin/image-only pages
            });
            console.log(`  Crawled: ${link.text} (${link.href})`);
        } catch (err) {
            console.log(`  Skipped: ${link.href} — ${err.message?.slice(0, 60)}`);
        }
    }

    await browser.close();

    return {
        ...data,
        screenshot: screenshotBuffer.toString('base64'),
        // crawledPages: per-page content for sitemap generation
        // always starts with Home; inner pages follow in nav order
        crawledPages,
    };
}
