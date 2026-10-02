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

### Still unknown

1. **Sudden Death**: no SD auction was captured. We need to confirm that
   `isSuddenDeath: true` appears and that `auctionEndTime` does not move on late bids.
2. **How a bid is placed**: the capture contains no bid by this user. The outgoing
   frames on the auction socket were only `phx_join`, `heartbeat`, `extend_session_v3`
   and `phx_leave`. The bid could be a GraphQL mutation or a socket push; we need one
   manual bid captured.
3. Whether `new_bid` with `bidAccepted: false` exists, e.g. for your own rejected bid.
