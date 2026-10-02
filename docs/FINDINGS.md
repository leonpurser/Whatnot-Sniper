# Findings from live captures

## Capture 1: 2026-10-02, normal auctions only (GBP, `rwtstores`-style "item on screen" show)

### Where auction state lives

The auction WebSocket. It is a Phoenix channels socket using the v2 JSON serializer.

```
wss://www.whatnot.com/services/auction/socket/websocket?_csrf_token=…&vsn=2.0.0
frame:  [joinRef, ref, topic, event, payload]
topic:  "commerce:<livestreamId>"        (livestreamId == id in /live/<id>)
```

| event | payload | meaning |
|---|---|---|
| `phx_reply` (topic `phoenix`) | heartbeat reply | arrives every ~10 s; used as the liveness signal |
| `phx_reply` (join) | `response.serverTimestamps.{accepted,responded}` | server clock sample |
| `user_joined` | `pinnedProduct`, `constants.minimumCustomBidIncrementData` | state on join |
| `auction_started` | `product`, `timestamp` | new lot; **new `product.id` per lot** |
| `new_bid` | `product`, `highestBidder`, `timestamp` | each accepted bid |
| `auction_ended` | `product` (`status: SOLD`) | end |
| `product_updated` | `product` | also sent for the **parent listing** (different id, inactive), which must be ignored |
| `payment_succeeded` | `product` | after the end |

`product` fields used: `id`, `parentId`, `name`, `isAuctionActive`, `auctionEndTime`
(server epoch ms), `isSuddenDeath`, `highestBid.priceCents`, `nextBidPrice{amount,currency}`
/ `nextBidCents`, `bidCount`, `livestreamId`, `bumpThresholdSeconds`, `bumpValueSeconds`.

The other socket, `/services/live/socket/websocket`, carries chat, reactions, view counts
and giveaways. It has no auction pricing.

DOM: the timer is `strong[data-testid="show-timer"]`. It shows whole seconds only and
rounds up. The price element has no stable attribute. The DOM updates about 20 ms after
the matching WebSocket frame.

### Timing observations

- `new_bid` arrives about 35–45 ms after its `payload.timestamp`, measured on the local
  clock before offset correction.
- Normal-auction bump: when a bid lands with less than 7 s left,
  `auctionEndTime = bid timestamp + ~6 988 ms`. In other words, the timer resets to about
  7 s, so a late bid in a normal auction cannot snipe.
- `auction_ended` arrived **866–891 ms after `auctionEndTime`** (2 of 2 auctions). The
  server seems to close the auction late, or apply a grace window. We need to find out
  whether bids sent inside that window are accepted before setting the sniper's
  deadline. That needs Sudden Death data.
- Clock offset from HTTP Date intervals: +37 ms ± 68 ms after 202 samples. Server
  timestamps now add lower bounds.

## Capture 2: 2026-10-02, two manual bids, one Sudden Death auction (seen on join)

### How the page bids

A Phoenix push on the **same** auction socket and channel:

```
→ [joinRef "11", ref "21", "commerce:<livestreamId>", "place_bid", {
     bidType: "STANDARD_BID", isCustomBid: false,
     price: { amount: 100, currency: "GBP" },        // = nextBidPrice at that moment
     productId: "<auction product.id>",
     sloStories: [...telemetry...], validatePotentialTrollBid: false }]
← new_bid broadcast (highestBidder = us)            ~102 ms after send
← [ "11", "21", topic, "phx_reply", { status: "ok", response: {
     serverTimestamps: { accepted, responded }, highestBidder: {...} } }]   ~145–165 ms
```

The second bid carried `price.amountSafe: 700` in addition to `amount`; it is not needed.

- Send → server `accepted`: ~57 ms (raw clocks). The round-trip interval for the
  offset is `[responded − received, accepted − sent]` = `[-92, 57]` ms from one bid.
  Combined with the Date headers this narrows to about ±30 ms.
- Our user id is the live-socket channel `general:<userId>`. `new_bid.highestBidder.id`
  tells us whether we are already winning.

### Sudden Death (one auction, joined 590 ms before its end)

`isSuddenDeath: true`, `auctionIncrementEndTime: false` (it was `true` on every normal
auction), `bumpThresholdSeconds`/`bumpValueSeconds: null`. `auction_ended` arrived
**1 209 ms** after `auctionEndTime` (normal auctions: 859–898 ms).

## Capture 3: 2026-10-02, four Sudden Death auctions (stream `59c54b1e…`)

- **The end time is fixed.** `auctionEndTime` never changed on any `new_bid`, in all 4
  auctions. One bid was accepted **252 ms** before the end (server timestamp), and the
  end time did not move.
- These SD auctions last about 9.9 s from `auction_started`.
- `auction_ended` arrived **977–1150 ms** after `auctionEndTime` (estimated server clock).
- Someone else's late bid reaches us about 70 ms after its server timestamp. If we are
  outbid at T−300 ms, we learn about it at around T−230 ms.
- An auction can **start with a bid already on it** (`auction_started` with `bidCount: 1`,
  highest £1, next £2), probably a pre-bid.
- `new_bid`, `product_pinned` and `product_unpinned` also arrive for **other,
  not-yet-live products** (`isAuctionActive: false`, no `auctionEndTime`). These are
  ignored unless they carry the tracked auction's id.

### Still unknown

1. **The real acceptance cutoff.** Is a bid accepted at T−100 ms? At T+100 ms, inside
   the ~0.9–1.2 s before `auction_ended`? This can only be measured with dry runs first,
   then small live bids, comparing `serverRemainingMs` with the outcome.
2. What a rejected bid's `phx_reply` looks like (`status: "error"` presumably), and
   whether `bidAccepted: false` is ever broadcast.
