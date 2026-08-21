# Responsive rules

How the app's CSS decides what a visitor gets. There is no bundler and no
framework here: three stylesheets (`public/styles.css`, `styles-deferred.css`,
`studio-modal.css`, plus the shared `genesis-header.css`) and plain media
queries.

`scripts/device-check.js` is the check for everything below. It drives seven
real device viewports, from a 390px iPhone to a 2560px desktop, and asserts what
this document claims.

## Ask the right question

Three different constraints get confused for each other, and the app used to ask
about width for all of them.

| What you want to change | Query to use |
| --- | --- |
| Where things sit — columns, stacking, fullscreen modals | `max-width` |
| Whether a tall arrangement fits at all | `max-height` |
| How big a control has to be to hit | `pointer: coarse` |
| Whether an affordance can be revealed by hovering | `hover: none` |

The failures that come from picking the wrong one are not subtle:

- **A phone in landscape** is ~850x390. It is *wider* than every width
  breakpoint in the app, so it used to get the desktop layout in 390px of
  height. The tune browser's fixed chrome is taller than that, and the file list
  — the only flexible child — was squeezed to zero. The search reported its
  matches and showed none of them. Layout blocks are therefore
  `@media (max-width: 720px), (max-height: 560px)`.
- **A tablet** is a touch device wider than every breakpoint, so it used to get
  mouse-sized controls: 26x24 navigation buttons, 21px sort headers, 30px rows.
  Sizing blocks are therefore `@media (max-width: 720px), (max-height: 560px),
  (pointer: coarse)`.
- **Browser zoom at 200%** on a laptop behaves exactly like a short, narrow
  viewport, so the same two queries cover it. This is what makes the WCAG 1.4.10
  reflow requirement hold without a separate rule.

Keep layout and sizing in *separate* blocks even when they read as one idea. A
tablet wants the finger-sized controls and the side-by-side browser at the same
time; merging them forces a choice.

## A modal is not a fixed box

Every modal sizes to the viewport with a cap, never to a literal:

```css
width: min(1100px, calc(100vw - 40px));
height: 92vh;
max-height: 900px;
```

A flat `max-height: 650px` is how the tune browser ended up showing three search
results on a 1440px screen.

Inside a modal that is a column of fixed-height chrome around one `flex: 1`
child, that child absorbs the whole shortfall. Give it a floor
(`.file-list { min-height: 8rem }`) so a short viewport can never crush it to
nothing — let the chrome scroll instead.

Note that a media query inside a modal still asks about the **viewport**, not
the panel. The Studio's panels are ~250px narrower than the window (rail plus
padding), which is why the option rows have their own stacking rule at
`max-width: 900px` in `studio-modal.css` rather than relying on the 768px one in
`styles-deferred.css`.

## Spend height on content

Chrome that is inert should not hold its space. The tune browser marks itself
`.has-tune` when a tune is selected (`hvsc-browser.js`, `markInfoPanel`), and
the transport and spectrum strip below the listing wait for it — before that
every control is disabled and the spectrum has no audio to draw. The info panel
uses the matching `.has-info` flag. Together these are the difference between
three visible tunes and ten.

## Targets and text

- 44px minimum for a touch target, 24px (WCAG 2.2) under a mouse. A control
  wrapped in its own `<label>` counts at the label's size.
- 12px floor for text. Badges and captions had drifted to 9-11px.
- 4.5:1 contrast for body text, 3:1 for large. The C64 colour swatches are
  exempt under 1.4.11 — reproducing the machine's palette is the point — and
  carry a light divider instead.

## Reaching things without a mouse

A `:hover` rule that *reveals* or *explains* something needs a touch
counterpart, or the information simply does not exist on a phone. Two cases in
the app: the drop-zone instruction over the logo preview, and the reason a
dimmed gallery logo cannot be used, which used to live only in a `title`
tooltip. Both now render under `@media (hover: none)` or as real text.

Similarly, double-click is a file-manager habit no touchscreen teaches. A folder
row in the tune browser opens on a single tap when
`matchMedia('(pointer: coarse)')` matches.

## Known gaps

- No `viewport-fit=cover` on any page, so the two `env(safe-area-inset-*)` calls
  (`styles-deferred.css`, `studio-modal.css`) currently evaluate to zero. iOS
  insets the whole layout viewport instead, so nothing lands under the Dynamic
  Island — the cost is that the fullscreen modals cannot paint edge to edge.
  Adopting it means adding insets to both modal headers, both close buttons and
  the analysis chip at the same time.
- The 16-segment colour strip is width-bound: 19px a colour on a 390px phone,
  against 29px on a tablet. Sixteen targets in a row cannot all clear 24px on a
  screen that narrow without wrapping the strip.
- `.page-tabs` is a `role="tablist"` where every tab is its own tab stop, rather
  than the roving tabindex the APG asks for.
