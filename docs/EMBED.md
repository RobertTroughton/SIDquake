# Embedding the SIDquake HVSC browser

SIDquake self-hosts the High Voltage SID Collection and exposes the browser as
an embeddable widget, so other sites can let visitors search, preview and pick
SID tunes from our mirror. The supported integration is an **iframe** that
talks to the host page via `postMessage`.

> Please read and honour [`/embed-terms.html`](../public/embed-terms.html): keep
> the attribution visible, and don't use the embed to scrape/bulk-download the
> collection (it's a free download at <https://hvsc.c64.org/>).

## Quick start

```html
<iframe
  src="https://sidquake.c64demo.com/hvsc-embed.html?mode=link&origin=https://your-site.example"
  width="900" height="600" style="border:0"
  title="HVSC Browser"></iframe>

<script>
  window.addEventListener('message', (e) => {
    if (e.origin !== 'https://sidquake.c64demo.com') return;   // trust only us
    const msg = e.data || {};
    if (msg.type === 'hvsc:selected') {
      console.log('Picked', msg.title, 'by', msg.author, '->', msg.url);
      // msg.url is a short-lived SID URL you can load/play.
    }
  });
</script>
```

## Options

Every option is a query parameter on the `hvsc-embed.html` URL, parsed by
[`public/hvsc-embed-config.js`](../public/hvsc-embed-config.js). Anything you
leave out keeps its default, so the shortest useful embed is
`?mode=file&origin=…`.

Switches take `1`/`0` (also `on`/`off`, `yes`/`no`, `true`/`false`); a bare
`?viz` with no value counts as on. Colours take a hex value with or without the
`#` (`accent=3fe07f`, or `accent=%233fe07f`) or a CSS colour keyword
(`accent=tomato`); anything else is ignored, so a typo leaves the default rather
than breaking the page. Folder options accept a path with or without the
constant `C64Music/` prefix.

The **Embed HVSC** tab on the site is the same reference with a live widget
attached, and a gallery of worked examples. Keep the two in step.

### What the widget hands back

| Option | Values | Default | Meaning |
|--------|--------|---------|---------|
| `mode` | `link`, `file`, `play` | `link` | How selections are returned (see [Modes](#modes)). |
| `origin` | an origin | the referrer's origin | Where results are posted. **Set it:** with no resolvable origin, `file`/`link` selections are refused (the widget posts an `hvsc:error` instead of handing tune data to an unknown parent) and `play` announces metadata only. |

### What it shows and does

| Option | Values | Default | Meaning |
|--------|--------|---------|---------|
| `start` | folder path | collection root | Open the browser at a folder, e.g. `MUSICIANS/D/Drax`. |
| `root` | folder path | whole collection | Confine the widget to a folder and everything under it: Home lands there, Up stops there, searches only match inside it, and a `tune`/`start` outside it is ignored. |
| `tune` | tune path | — | Open on one tune, e.g. `MUSICIANS/H/Hubbard_Rob/Commando.sid`. It is selected, described and started on arrival. |
| `q` | text | — | Open with a search already run. |
| `sort` | `name`, `year`, `match` | remembered, else `name` | Initial order. `match` (relevance) applies to searches only. |
| `dir` | `asc`, `desc` | per `sort` | Direction. Names default A–Z, years and relevance strongest first. |
| `autoplay` | switch | `0` | Start playing as soon as a tune is picked, rather than waiting for Play. |

### Chrome

Each of these switches one part of the widget on or off; all default to on.

| Option | Controls |
|--------|----------|
| `header` | The title row and the search box together. |
| `title` | *(text)* The heading, default `HVSC Browser`. `title=` (empty) drops it. |
| `badge` | The `HVSC #NN` pill saying which release the mirror is current with. |
| `search` | The search box. |
| `placeholder` | *(text)* Its placeholder. |
| `nav` | The Home and Up buttons above the list. |
| `sortui` | The clickable Name / Year / Best match column headers. Off leaves the order fixed at `sort`. |
| `year` | The release-year column. |
| `info` | The SID details panel. |
| `infotitle` | *(text)* Its heading, default `SID Info`. |
| `stil` | The STIL commentary inside it. |
| `download` | Its Download SID button. |
| `share` | Its Share Link button. |
| `player` | The transport (play, stop, restart, subtunes, elapsed time). |
| `credit` | The "Playback by libsidplayfp" line under the transport. |
| `viz` | The spectrum strip along the bottom. |
| `status` | The whole status bar; `count`, `path` and `select` switch its three parts individually. |
| `selectlabel` | *(text)* The Select button's wording, default `Select`. |

The attribution footer is deliberately **not** switchable — keeping it visible is
part of the embed terms.

### Colours and type

`theme` is a preset for everything below it, so `theme=light&accent=c0392b` does
what it looks like it does.

| Option | Sets |
|--------|------|
| `theme` | `dark` (default) or `light`. |
| `bg` | The page behind the widget (`--bg-primary`). |
| `panel` | The widget's own background, under the file list (`--bg-secondary`). |
| `surface` | Raised blocks: buttons, transport, search field (`--bg-surface`). |
| `bar` | Header, status bar and footer (`--bg-elevated`). |
| `hover` | Row and button hover tint (`--bg-hover`). |
| `accent` | Selected row, Select button, version badge, focus ring. Its lighter and translucent variants (`--accent-light`, `--accent-dim`, `--accent-glow`, `--border-accent`, `--accent-gradient`) are derived from it. |
| `accent2` | The secondary accent (`--accent-secondary`). |
| `text` | Primary text (`--text-primary`). |
| `text2` | Secondary text (`--text-secondary`). |
| `muted` | Muted text: status bar, footer, placeholders (`--text-muted`). |
| `border` | Separators (`--border`). `--border-light` and the higher-contrast `--border-control` are derived from it. |
| `infobg` | The SID details panel, deliberately darker than the rest (`--hvsc-info-bg`). |
| `viz1` | Colour of the lowest spectrum bar. Only its **hue** is taken — brightness follows the music. |
| `viz2` | Colour of the highest spectrum bar, same again; the bars ramp between the two. |
| `radius` | Corner roundness in pixels, 0–24, for every control in the widget. |
| `font` | A font-family list, e.g. `font=Georgia,serif`. Only families already on the visitor's machine — the frame loads no webfonts of yours. |

Colours are applied as custom properties on the iframe's `<html>`, overriding
the `:root` block in `styles.css`. Nothing an embedder passes reaches the page as
raw CSS: values are matched against hex/keyword patterns first, and the font list
against the characters a family name is made of.

### Examples

```
# a compact picker: list and search only
?mode=link&origin=https://your-site.example&info=0&viz=0&player=0&selectlabel=Use%20this

# a jukebox for one musician
?mode=play&autoplay=1&select=0&info=0&root=MUSICIANS/H/Hubbard_Rob&nav=0

# opening on a search, oldest first
?mode=file&origin=https://your-site.example&q=galway&sort=year&dir=asc

# a light host page
?mode=file&origin=https://your-site.example&theme=light

# green terminal
?mode=play&bg=00160c&panel=001f11&surface=002a17&bar=001a0e&hover=00381f
 &text=b8ffd8&text2=6fd6a0&muted=6fd6a0&border=0a4d2c&accent=3fe07f
 &infobg=001a0e&viz1=3fe07f&viz2=aaffcc&radius=0
```

## Messages sent to the host (`window.parent.postMessage`)

All payloads include: `name`, `path`, `url`, `title`, `author`, `released`, `stil`.

| `type`           | When | Extra |
|------------------|------|-------|
| `hvsc:ready`     | Widget loaded. | `mode` (the resolved mode) |
| `hvsc:selected`  | User chose a tune in `link`/`file` mode. | `mode`; in `file` mode also `bytes` (an `ArrayBuffer` of the SID, transferred). |
| `hvsc:playing`   | User chose a tune in `play` mode (preview only). | — |
| `hvsc:error`     | A selection couldn't be fetched (`file` mode). | `message` |

### Modes

- **`link`** — returns metadata + a short-lived SID `url`. Lightest; the host
  fetches/plays the URL itself. URLs carry an access token and expire (~10 min),
  so treat them as ephemeral, not permanent hotlinks.
- **`file`** — as `link`, plus the SID `bytes` (`ArrayBuffer`), handy for
  sandboxed hosts that can't fetch cross-origin.
- **`play`** — discovery only: the widget previews tunes in-place and just
  announces what's playing; nothing is handed over.

Always check `event.origin === 'https://sidquake.c64demo.com'` before trusting a
message.

## Server configuration (SIDquake operators)

Access to raw `.sid` files is gated by a short-lived HMAC token so the mirror
isn't a free bulk-download endpoint (see `netlify/edge-functions/`).

- **`HVSC_TOKEN_SECRET`** — set this in the Netlify environment to enable token
  gating. Any non-empty random string. **Until it's set, gating is disabled**
  (SIDs serve normally), so deploys don't break before you configure it.
- **`HVSC_EMBED_ORIGINS`** — optional comma-separated list of third-party
  origins allowed to request tokens *cross-origin* (the iframe itself is
  same-origin and always works, so most setups don't need this).

Also in effect: `robots.txt` + `X-Robots-Tag: noindex` keep the raw files and
index out of search; the edge guard blocks known AI/crawler/scraper user-agents.

## Notes & limits

- The iframe is served from our origin, so its own requests (token, index, raw
  SID) are same-origin *inside the iframe* — no CORS setup needed on the
  embedder's side. **One caveat:** in `mode=link` the widget hands you a SID
  `url` on our origin; if your page then `fetch()`es that URL itself, that call
  is cross-origin and our raw-SID responses don't send CORS headers, so it will
  fail. Use `mode=file` (SID `bytes` are delivered over `postMessage`, no fetch)
  or `mode=play` (preview only) to avoid re-fetching cross-origin.
- A determined scraper spoofing headers isn't fully stopped; this is
  deliberate "raise the bar" protection, not DRM. The collection is freely
  available at its source regardless.
