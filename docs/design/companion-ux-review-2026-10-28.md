# Design review: Vintrack Companion

## Summary

The Companion helps Vinted shoppers turn the current search into a monitor, track an item's price, and review their finds without losing their browsing context. Its identity is a quiet graphite utility with the current Vinted context as the visual anchor. The original implementation had **Critical issues** in accessibility; the revised implementation is **Good**, with keyboard navigation, legible status colors and recoverable loading states.

Scope: shared vanilla JavaScript/CSS used by the Chrome/Firefox popup and the injected Vinted drawer. Reviewed from source and synthetic browser fixtures, starting at `origin/main` commit `5818358` (v2.7.10), fetched on 2026-10-28. Existing changes in the original checkout were preserved in place; implementation lives in a separate worktree. Apple foundations are translated into web semantics; native macOS menu bars, native tab bars, and native material requirements do not apply to this browser extension.

Source locations below refer to the reviewed baseline commit `5818358`; implementation references use function or selector names so they remain easy to find.

## Critical findings addressed

- **Critical — Status contrast and color-only emphasis** (`apps/vintrack-browser-sync-extension/companion.css:12`). The original `#0f9f6e` success text had approximately **2.95:1** contrast on its composited `#e2f3ed` pill. It is now `#087453` on `#e9f6ef`, **5.20:1**, with a checkmark and the existing explicit text. Dark success is `#73dfb4` on `#143c32`, **7.52:1**. See `apps/vintrack-browser-sync-extension/companion.css` (`.vtc-status-ok`). `accessibility.md › Vision`: “Strive to meet color contrast minimum standards.”
- **Critical — Incomplete keyboard semantics** (`apps/vintrack-browser-sync-extension/companion.js:173`). The previous buttons had `aria-selected` without tab roles or associated panels. The shared component now exposes named tabs/panels, roving tab order, Left/Right/Home/End navigation, visible focus and focus preservation across data refreshes. The real closed Shadow DOM drawer now declares a modal dialog, traps Tab/Shift+Tab, closes with Escape and restores its opener. See `companion.js` (tab construction, `rememberPanelFocus`, keyboard handler) and `content-script.js` (`openCompanionDrawer`). `accessibility.md › Speech`: “Let people use the keyboard alone to navigate and interact with your app.”

## Improvements addressed

- **High — Connection health was below the fold** (`apps/vintrack-browser-sync-extension/companion.js:403`). The account summary now precedes the current Vinted context. Recovery actions expand when login or sync needs attention; routine connection actions are disclosed on demand. `layout.md › Visual hierarchy`: “Order content by relative importance.”
- **High — Small text and hidden search filters** (`apps/vintrack-browser-sync-extension/companion.css:107`, `companion.css:390`). The previous 9–10 px utility labels, truncated titles and one-line filter clipping made the available information hard to inspect. The revised scale uses relative units, wraps titles and filters, and keeps navigation labels readable at 200% content text size. `typography.md › Ensuring legibility`: “Use font sizes that most people can read easily.”
- **Medium — Nine equally weighted destinations competed with the current task** (`apps/vintrack-browser-sync-extension/companion.js:441`). Dashboard, Monitors and Watches remain immediately available below the context; six other destinations sit under native `<details>` disclosure. No destination was removed. `layout.md › Visual hierarchy`: “Use progressive disclosure to make layouts cleaner and easier to interact with.”
- **Medium — Success disappeared during refresh; request failure resembled an empty list** (`apps/vintrack-browser-sync-extension/companion.js:266`, `companion.js:717`). A persistent polite live region reports results, successful sync survives refresh, failed refresh preserves the last known data, watch failures offer retry and preserve previously loaded pages. Slow operations disable their affected controls while tabs and Close remain usable. `feedback.md › Best practices`: “Consider integrating status feedback into your interface.”
- **Medium — Empty states described implementation concepts** (`apps/vintrack-browser-sync-extension/companion.js:392`). Linking now names the actual Account action; an unsupported page explains how to monitor a search or track a price. `writing.md › Best practices`: “Provide clear next steps on any blank screens.”

## Token and layout plan

Six core color roles, implemented as CSS custom properties with light/dark variants. Ratios use WCAG relative sRGB luminance; content colors are measured on the panel, signals on their actual tinted background.

| Role | Light | Dark | Contrast, light / dark |
| --- | --- | --- | --- |
| Surface: background / panel | `#f3f5f8` / `#ffffff` | `#111824` / `#182131` | Not text |
| Content | `#182131` | `#ebf0f8` | 16.14 / 14.11 |
| Secondary content | `#53627a` | `#aebbd0` | 6.18 / 8.32 |
| Primary action | `#17243a`, white label | `#dbe7ff`, `#17243a` label | 15.56 / 12.51 |
| Success | `#087453` on `#e9f6ef` | `#73dfb4` on `#143c32` | 5.20 / 7.52 |
| Destructive/error | `#b42338` on `#fff0f2` | `#ff9eab` on `#421f2a` | 5.87 / 7.34 |

Warning: `#7a4b00` on `#fff5dc` (6.83:1), dark `#ffd583` on `#3d301b` (9.22:1). Borders strengthen when `prefers-contrast: more` is active; forced colors uses system focus highlighting. Theme follows the OS when no saved Vintrack theme exists and retains the existing dashboard theme synchronization.

Type: system UI throughout, 18 px restrained brand heading, 16 px context title, 15 px account title, 13 px body/actions, 12 px supporting text, 11 px utility labels at the default 16 px root. All content uses rem; tab labels and decorative brand glyphs have upper bounds to avoid taking space away from enlarged content. Counts and prices use tabular numerals. No additional display or utility typeface is needed for this small task surface.

Layout: a single scrollable task column at both compact and regular widths; cards, filters, actions and the footer wrap to available space.

```text
Compact (320 px)             Regular (420–430 px)
┌ Companion       Refresh ┐  ┌ Companion             Refresh ┐
│ Overview Feed Watches   │  │ Overview     Feed     Watches │
├─────────────────────────┤  ├───────────────────────────────┤
│ Account · state         │  │ Account                 state │
│ Connection actions ▸    │  │ Connection actions ▸          │
│ Current Vinted context  │  │ Current Vinted context        │
│ Filters wrap            │  │ Filters wrap                  │
│ [Create monitor]        │  │ [Create monitor]              │
│ Copy search link        │  │ Copy search link              │
│ Counts · Destinations   │  │ Counts · Destinations         │
│ More destinations ▸     │  │ More destinations ▸           │
├─────────────────────────┤  ├───────────────────────────────┤
│ Inline setting / key    │  │ Inline setting / shortcut     │
└─────────────────────────┘  └───────────────────────────────┘
```

Signature: the graphite edge of the current-context card joins the Vinted search to its single primary action. This is studio judgment, grounded in the extension's actual job. The plan deliberately removes large metric cards and repeated status wording so the current search gets the emphasis. A decorative new palette would not help this product. No animation or translucent content surfaces are necessary; removing the pulse, gradients, card shadows and header blur also makes reduced-motion and reduced-transparency behavior straightforward.

`buttons.md › Style`: “Keep the number of prominent buttons to one or two per view.” `liquid-glass.md › Where the material belongs`: “Use Liquid Glass effects sparingly.” The browser uses ordinary opaque CSS surfaces, not an imitation of native glass.

## What works and stays

Explicit creation handoffs, the existing account linking protocol, feature capability checks, the destructive confirmation for watch deletion, and the feed's 12-second refresh only while its tab is selected remain intact. The Companion remains a browsing and monitoring surface.

## Validation and limits

- `npm run lint` and `npm run build` pass in `apps/control-center`; Prisma Client generated for the isolated checkout.
- Extension validator passes all 83 session/checkout regressions; Chrome, development and Firefox packages build.
- Companion Playwright suite covers keyboard tabs, live feed focus, delayed requests, retry, preference rollback, persistent sync confirmation, failed refresh retention, linking guidance, light/dark themes, 320 px with 200% text, and the real closed Shadow DOM drawer's focus cycle/Escape restoration.
- Screenshots in `docs/screenshots/companion-*.png` use synthetic accounts/items. Before and after at 420×600; additional dark feed and 320 px / 200% text captures are included. Enlarged content remains scrollable, with no horizontal overflow.
- No live linked account or Vinted network request was used. Native screen reader announcements, physical lighting, Firefox rendering and upstream account behavior are not verified by the Chromium fixtures.
