# ui-ux-pro-max

Design intelligence database used at runtime to ground CSS and HTML generation in industry-appropriate decisions.

## What it provides

- **67 UI styles** — glassmorphism, brutalism, editorial, neumorphism, etc. with CSS keywords and AI prompt hints
- **161 color palettes** — indexed by product/industry type (restaurant, law firm, SaaS, etc.)
- **57 typography pairings** — Google Fonts combinations with import URLs
- **UX guidelines** — best practices and anti-patterns by product category

## Usage

```bash
python3 scripts/search.py "<query>" --domain <domain> -n <max_results>
```

**Domains:** `color` · `typography` · `style` · `ux` · `landing` · `chart` · `product`

**Examples:**
```bash
python3 scripts/search.py "restaurant" --domain color -n 1
python3 scripts/search.py "professional service" --domain typography -n 2
python3 scripts/search.py "modern" --domain style -n 3
python3 scripts/search.py "law firm" --domain ux -n 2
```

## Data files

The CSV data files are NOT in this repository (too large, ~5MB).

Install them:
```bash
npm install -g uipro-cli
cp -rL $(npm root -g)/uipro-cli/assets/data ui-ux-pro-max/data
```

Or clone the full skill repo:
```bash
git clone --depth 1 https://github.com/nextlevelbuilder/ui-ux-pro-max-skill /tmp/uipro
cp -r /tmp/uipro/src/ui-ux-pro-max/data ui-ux-pro-max/data
```

## Integration in Webpitch

`design/generate.js` calls `queryUXPro()` four times in parallel before generating any CSS or HTML:

```js
const [uxColorData, uxTypographyData, uxStyleData, uxGuidelinesData] = await Promise.all([
    queryUXPro(analysis.businessType, 'color', 1),
    queryUXPro(`${analysis.tone} ${analysis.businessType}`, 'typography', 2),
    queryUXPro(`${analysis.businessType} ${analysis.tone}`, 'style', 2),
    queryUXPro(analysis.businessType, 'ux', 2),
]);
```

Results are injected as context blocks into `generateDesignSystem()` and `generatePageHTML()`.

## Source

https://github.com/nextlevelbuilder/ui-ux-pro-max-skill — MIT License
