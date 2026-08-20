# IDESIGN — website

Static site. Plain HTML, CSS and one small JavaScript file. No build step, no framework, no database. Open any `.html` file in a browser and it works.

---

## What's here

```
index.html          The index — five companies, click to enter
landscape.html      IDESIGN Landscape — architecture
cgi.html            IDESIGN CGI — product design & visual content
lifestyle.html      IDESIGN Lifestyle — the shop
idefenda.html       IDEFENDA LAB — AI, software & security
badili-bongo.html   Badili Bongo — animation production
group.html          About the group
contact.html        Enquiry form + phone numbers + emails
thanks.html         Shown after the form is submitted
404.html            Page-not-found

style.css           All styling. One file.
script.js           Language toggle (EN/SW) + strapline fitting
images/             Your photographs go here
fonts/              TT Fors webfont files go here

robots.txt  sitemap.xml  netlify.toml  _redirects   Search engines & hosting
```

Total: 70 KB. It will load fast on a Tanzanian mobile connection.

---

## Launch in four steps

### 1. Register the domain

`idesign.co.tz` is not yet registered. Options:

**.co.tz (recommended — signals a real Tanzanian business)**
Go through a TCRA-accredited registrar. Established ones include **Tanzania Online**, **Habari Node** and **Extreme Web Technologies**. Expect roughly TZS 30,000–60,000 per year. You will need your business registration details.

**.com (faster, no paperwork)**
Namecheap or Cloudflare, about USD 10–12 per year, registered in minutes.

Many businesses buy both and redirect one to the other. If you do, make `.co.tz` the main address.

### 2. Put the site online

**Netlify — free, and this site is already configured for it**

1. Create an account at netlify.com
2. Drag this entire folder onto the upload area
3. It goes live immediately on a temporary address like `idesign-xyz.netlify.app`

`netlify.toml` and `_redirects` are already set up with security headers and caching. The contact form works automatically — Netlify catches submissions and emails them to you. No server needed.

Alternatives: **Cloudflare Pages** (also free, faster in Africa) or **Vercel**. Any normal web host with FTP works too — just upload the files.

### 3. Point the domain at the site

In Netlify: **Domain settings → Add custom domain**. Netlify shows you the DNS records to create. In your registrar's control panel, add them. Wait up to 24 hours.

HTTPS is issued automatically and free. Do not pay anyone for an SSL certificate.

### 4. Set up email

You need `landscape@`, `cgi@`, `shop@`, `lab@` — the addresses already on the contact page. Options:

- **Zoho Mail** — free for up to five users on your own domain. Best value.
- **Google Workspace** — about USD 6 per user per month.
- **Forwarding only** — most registrars forward `anything@idesign.co.tz` to a Gmail address for free. Cheapest way to start.

---

## Before you launch — checklist

**Must fix**
- [ ] Add the shop street address, opening hours and phone number (`lifestyle.html`, `contact.html`)
- [ ] Confirm the working YouTube handle — `@jobarick` returned 404
- [ ] Replace placeholder project images with real photography
- [ ] Fix the Instagram account names (see below)

**Should fix**
- [ ] Buy the TT Fors web licence and install the font (see below)
- [ ] Write 6–10 real case studies to replace the placeholder captions
- [ ] Raise the Houzz job-cost band — $100–$10,000 anchors you as a garden service
- [ ] Point every Google Maps pin at its own company page, not the homepage
- [ ] Rebuild the Linktree to point at this site

**After launch**
- [ ] Submit `sitemap.xml` to Google Search Console
- [ ] Add a Google Business Profile for the shop, with photos and hours

---

## Instagram — what I found

Reading the four accounts turned up a problem worth fixing before you drive any traffic to them:

| Handle | Display name | Posts | Followers | Bio |
|---|---|---|---|---|
| `@idesign_lifestyle` | **"Idesign Landscape"** ❌ | 534 | 1,196 | "upgrade your Lifestyle" |
| `@jobarick` | **"Idesign_landscape"** ❌ | 257 | 600 | "Upgrade your Lifestyle" |
| `@idesign_cgi` | "idesign CGI" ✓ | 40 | 169 | "upgrade your Lifestyle" |
| `@badilibongo_` | "badili bongo" ✓ | 17 | 77 | "sustainable transformation project for Gen Alpha" |

**Two different accounts are both called "Idesign Landscape"** — and neither of them is the architecture practice. Anyone searching Instagram for your architecture work finds a textiles shop.

**Three accounts share the bio "upgrade your Lifestyle."** That line describes the shop. On the CGI account it tells a manufacturer nothing about product design.

Suggested fix — takes ten minutes:

| Handle | Set display name to | Set bio to |
|---|---|---|
| `@idesign_lifestyle` | IDESIGN Lifestyle | Home Comfort Essentials · Dar es Salaam |
| `@idesign_cgi` | IDESIGN CGI | Product Design & Visual Content · From concept to shelf to screen |
| `@jobarick` | Ibrahim Alibariki Jonathan | Curator & Architect · Concept Designer · Educator |
| `@badilibongo_` | Badili Bongo | Sustainable Transformation · Children's stories, animated |

There is no account for IDESIGN Landscape or IDEFENDA LAB. Both need one.

**Getting your photos out:** don't screenshot from the web — those are compressed. Use Instagram's own export: **Settings → Accounts Centre → Your information and permissions → Download your information**. Choose JPEG, high quality. You get every original file. Do this for each account. It arrives by email within a day or two.

---

## Adding your images

Drop files into `images/`, then find the placeholder in the HTML:

```html
<div class="ph"><i data-en="Image" data-sw="Picha">Image</i></div>
```

Replace with:

```html
<div class="ph"><img src="/images/courtyard-villa.jpg"
     alt="Courtyard Villa, Kigamboni" loading="lazy" width="800" height="600"></div>
```

Before uploading, resize to **1600px on the long edge** and save as JPEG at about 80% quality — roughly 200–400 KB each. Large phone photos will make the site slow. [Squoosh.app](https://squoosh.app) does this free in the browser.

Always write the `alt` text. It's what a screen reader announces and what Google reads.

---

## Installing TT Fors

TT Fors is a commercial typeface from TypeType. Buy the **web** licence (not just desktop) at typetype.org.

1. Put `TTFors-Bold.woff2` and `TTFors-Regular.woff2` into `fonts/`
2. Open `style.css`
3. Near the top, delete the `/*` and `*/` around the two `@font-face` rules

Every wordmark switches over. Until then it falls back to Outfit, a free geometric sans that sits close.

---

## Editing text

All text sits in the HTML. Each translatable element carries both languages:

```html
<p data-en="We design it and we build it." data-sw="Tunabuni na tunajenga.">We design it and we build it.</p>
```

Change **both** `data-en` and the visible text between the tags — they must match. Change `data-sw` for the Swahili.

The Swahili throughout was written carefully but not by a native speaker. **Have someone read it before launch**, particularly the taglines, where tone matters more than literal accuracy.

---

## Notes

- The contact form works out of the box on Netlify. On another host, use [Formspree](https://formspree.io) — replace the form's `action` with your Formspree URL and delete the `data-netlify` and `form-name` attributes.
- A spam honeypot is already in place.
- Language choice persists across pages via `localStorage`.
- The site works without JavaScript — the toggle simply won't switch.
- Never commit the TT Fors font files to a public repository. The licence doesn't allow redistribution.
