# Whatnot Bid Assistant (Chrome extension, Manifest V3)

A bidding/sniping assistant for live auctions on Whatnot's desktop site. It runs in the
Whatnot tab you are already logged into. It never asks for credentials.

**Current stage: milestone 1 — inspection.** The extension loads on Whatnot, detects the
livestream, captures everything the page receives and gives you tools to find where the
auction state comes from. **It cannot place a real bid**: the bid executor is a stub
that only validates and dry-runs.

## Install (unpacked)

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select this folder.
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
                       content/sources/*  (AUCTION STATE READERS — none registered yet)
                                │  store.update({...}, sourceName)
                                ▼
                       content/auction-state.js   INTERNAL AUCTION STATE
                                │                 identity changes reset everything,
                                │                 finished auctions are retired
                                ▼
                       content/sniper.js          TIMING ENGINE (arm state only for now)
                                │  placeBid(expectedAuctionId, max, opts)
                                ▼
                       content/bid-executor.js    BID EXECUTOR: lock → validate → dry-run/execute
                                                  (performBidAction not implemented)

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
- Dry run is forced on.

## Development

```
npm test        # unit tests for safety, state store, clock, discovery, executor, sniper
npm run check   # syntax-check every JS file
```

## Next steps

See [docs/INSPECTION.md](docs/INSPECTION.md) for what to capture on a real stream. Once
the real data source is known, we add a source in `content/sources/` that maps it into
`store.update(...)`. After that come the scheduler (milestone 2) and the real bid action.
