# mcp-property-records

Property Records MCP — address-level US property records (sales history,

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1679+ live data sources.

## Tools

| Tool | Description |
|------|-------------|
| `property_lookup` | Address-level US property records from county and city open-data portals — keyless public records, no API key. Answers "when did this house last sell", "how much did <address> sell for", "who owns this property", "what is the assessed value of <address>", "property sale history", "county assessor data for an address". Returns the property sale history (dated transactions with price where the county publishes it), current assessed value, owner of record, parcel id (DC SSL / NYC BBL / Philadelphia OPA account / Cook County PIN / SF block-lot), land use or building class, year built, square footage, and bed/bath counts where available. SUPPORTED JURISDICTIONS ONLY — property records are maintained per county and there is no national keyless source. Currently covered: ${COVERAGE_SUMMARY}. An address in any other county returns covered:false with the inferred jurisdiction and the supported list, so you can tell the user plainly that this county is not in the dataset rather than guessing. Call property_coverage first if you want the field-by-field capability matrix. Examples: {"address":"1642 30th St NW, Washington DC"} → DC row house, SSL 1282 0198, owner, $1,354,300 assessed, sold 2012-08-09 for $1,085,000, 3 bed / 2.5 bath / 1,510 sqft built 1907. {"address":"232 East 6th Street, Manhattan"} → NYC BBL 1004610024 with the 2016-present sale list. {"address":"228 Spruce St, Philadelphia"} → full recorded deed chain with grantor/grantee. {"address":"3000 N Sheffield Ave, Chicago"} → Cook County PIN, sale, assessed value. {"address":"450 Sutter St, San Francisco"} → assessed value and characteristics (no price — SF does not publish it). |
| `property_coverage` | The capability matrix for property_lookup: every county and city this pack can answer address-level property-record questions for, and exactly which fields each one publishes — sales history (and whether it includes a price), owner name, assessed value, physical characteristics — plus the data vintage, refresh cadence, per-jurisdiction caveats, and the upstream source URL. Use this before promising a user an answer, to check whether their county is in the dataset and whether the specific field they asked about (sale price, owner, bed/bath) actually exists there. US property records are county-maintained and there is no national keyless source, so this list is the whole supported set. Example: {} → 5 jurisdictions, of which 4 publish sale prices and 4 publish owner names. |

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "property-records": {
      "url": "https://gateway.pipeworx.io/property-records/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/property-records/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1679+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/property_lookup \
  -H 'Content-Type: application/json' \
  -d '{"address":"1600 Pennsylvania Ave NW, Washington DC"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/property_lookup`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "property-records": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-property-records"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-property-records
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Property Records data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
