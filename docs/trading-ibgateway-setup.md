# IB Gateway Setup (local, paper)

## Install

1. Download IB Gateway: https://www.interactivebrokers.com/en/trading/ibgateway-latest.php
2. Install for your OS. On first launch, choose **IB API** + **Paper Trading**.

## Configure API

In Gateway: **Configure → Settings → API → Settings**

- Socket port: `4002` (IB Gateway paper, default) — use `4001` when switching to live
- Trusted IPs: `127.0.0.1` (or add your bot's source IP if remote)
- Read-Only API: **OFF** (we place orders)
- Master API client ID: leave empty

Port reference (don't mix these up):
| Client       | Paper | Live |
|--------------|------:|-----:|
| IB Gateway   |  4002 | 4001 |
| TWS          |  7497 | 7496 |

## Smoke test

```bash
node trading/_spike.js
```

Expected output:

```
[ibkr] connected to 127.0.0.1:4002
[ibkr] accountSummary: { account: 'DUxxxxxx', tag: 'NetLiquidation', value: '1000000.00', currency: 'USD' }
[ibkr] accountSummary: { account: 'DUxxxxxx', tag: 'TotalCashValue', value: '1000000.00', currency: 'USD' }
[ibkr] accountSummaryEnd - success: true
```

Exit code: `0`.

### Troubleshooting

If the script hangs for 10s and prints `TIMEOUT`:
- Verify IB Gateway is logged in and not in "reconnecting" state.
- Verify the port number matches your client (IB Gateway paper=4002, TWS paper=7497).
- Verify `127.0.0.1` is in the Trusted IPs list and you clicked OK.
- Try `netstat -an | grep 4002` — should show LISTEN on that port.

If the script prints an error like `API client is not eligible` or `Socket connection broken`: the Gateway's Read-Only API checkbox is still on, or API clients aren't enabled at all.

## Environment variables

```bash
export IBKR_HOST=127.0.0.1
export IBKR_PORT=4002
export IBKR_CLIENT_ID=1
```

## Notes

- Gateway logs out after ~24 hours. For bot use, the typical pattern is a supervisor that restarts the Gateway daily and re-authenticates with 2FA.
- When switching to a live account, change the login type to **Live** at Gateway launch and set `IBKR_PORT=4001`.
