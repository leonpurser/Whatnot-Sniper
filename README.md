# Whatnot Bid Assistant (Chrome extension, Manifest V3)

A bidding/sniping assistant for live auctions on Whatnot's desktop site. It runs in the
Whatnot tab you are already logged into. It never asks for credentials.

**Current stage: milestone 2, bidding and sniping (testing).** Live auction state is read from
Whatnot's auction WebSocket. Bids are sent exactly as the page sends them: a `place_bid`
push on the page's own socket. The sniper fires at a configurable time before the server
end time. See [docs/FINDINGS.md](docs/FINDINGS.md).

**BID button**: works like Whatnot's own bid button. One click places a real bid at the
next amount, with no maximum needed. The safety checks still apply: right auction, still
active, exact next price, and never bidding against yourself.

**Auto-bid**: three selectable modes:
- **Snipe at the end**: one bid at the chosen time before the end. Normal auctions re-snipe
  automatically when outbid, because their timer resets.
- **Snipe + re-bid if outbid** (default): as above. If someone outbids you after your snipe
  with at least *N* ms still left, it bids again straight away. This matters for Sudden
  Death, where the end never moves.
- **Keep me winning**: bids whenever you are not the highest bidder, at any time.

All modes stop at your maximum and never bid against you. Auto-bid needs a maximum and is
**dry run by default**. Live auto-bidding must
be confirmed in the side panel, and it switches off on every page reload or stream change.

## Install

1. Get the extension, either:
   - this folder, or
   - `npm run package` → unzip `dist/whatnot-bid-assistant-<version>.zip`.
2. Go to `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and
   select the folder.
2. Open a Whatnot livestream, then click the extension icon. The side panel opens and stays
   open while you use the stream.
3. After editing the code, click reload on the extension card **and** reload the Whatnot tab.

## Architecture

```
WHATNOT PAGE
  │  page/page-hook.js         (MAIN world, document_start) observes WebSocket frames,
  │                            fetch/XHR responses; React/globals probes; click-to-pick
  ▼  window.postMessage
content/page-bridge.js ──► content/capture-store.js   ring buffer + field discovery
                                │
                                ▼  every observation
                       content/sources/*  AUCTION STATE READERS (whatnot-auction-socket.js)
                                │  store.update({...}, sourceName)
                                ▼
                       content/auction-state.js   INTERNAL AUCTION STATE
                                │                 identity changes reset everything,
                                │                 finished auctions are retired
                                ▼
                       content/sniper.js          TIMING ENGINE: setTimeout → MessageChannel spin → fire
                                │  placeBid(expectedAuctionId, max, opts)
                                ▼
                       content/bid-executor.js    BID EXECUTOR: lock → validate → dedupe → dry-run | send
                                │  bridge.request('place-bid')
                                ▼
                       page/page-hook.js          last-moment check (auction id, active, exact
                                                  next price) → place_bid on the page's socket

content/whatnot.js       wires it together + Port to the side panel
content/clock.js         server/client clock offset (interval intersection)
content/dom-probe.js     DOM discovery scan + mutation timeline
shared/safety.js         pure pre-bid validation (every check must pass)
shared/state.js          internal state shape
sidepanel/               UI (side panel instead of a popup: a popup closes when you click the stream)
background/              opens the side panel, sets the badge
```

Design rules already enforced:

- Money is stored as integer minor units (pence), so the max check never compares floats.
- `validateBid` fails safe. Unknown price, next bid, end time or identity counts as a failure.
  The next bid must come from Whatnot; increments are never invented.
- When the auction ID changes, all per-auction state is cleared, the sniper disarms
  (unless `keepArmedAcrossAuctions`), and the old ID is retired. Late messages for a
  retired auction are ignored.
- The executor has a lock, refuses duplicate `auctionId:amount` submissions, and
  re-validates at fire time. A stale timer therefore cannot bid on a different auction.
- Never bids against yourself (`not-already-highest`). Your user id comes from the
  page's `general:<id>` channel.
- Live mode is in memory only and is cleared on reload or stream change.
- `NO_REPLY` is reported as **outcome unknown**, never as "not placed".

## Look and feel

The side panel is styled to sit next to Whatnot's dark live view: near-black surfaces, a
bright yellow primary action, pill shapes and a bold geometric typeface. The font is
[Plus Jakarta Sans](https://github.com/tokotype/PlusJakartaSans) (SIL OFL, bundled in
`sidepanel/fonts`). To match Whatnot's exact typeface, change `--font` in
`sidepanel/sidepanel.css`. The icon (`icons/icon.svg`) is the extension's own mark, not
Whatnot's logo. Diagnostics live under the collapsed **Developer tools** section.

## Development

```
npm test        # unit tests + replay of a sanitized real auction capture (tests/fixtures)
npm run check   # syntax-check every JS file
npm run package # build dist/whatnot-bid-assistant-<version>.zip
```

## Testing plan

1. **Dry runs.** Arm several auctions in dry run (normal and Sudden Death) at different
   targets. The "Bid attempts & timing" table shows how far before the end each shot
   would have fired, and how late the scheduler was.
2. **Manual bids.** On cheap items, check that the BID button is accepted and note
   `server left` and `rtt`.
3. **Live sniping on Sudden Death.** Start conservatively (1000 ms) and step down
   (750 → 500 → 350 → 250), recording which bids are accepted. `server left` is exact:
   the server's own accept time against the end time, so no clock guess is involved.
