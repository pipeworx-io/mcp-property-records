# mcp-property-records

Property Records MCP — address-level US property records (sales history,

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1394+ live data sources.

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

Or connect to the full Pipeworx gateway for access to all 1394+ data sources:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English:

```
ask_pipeworx({ question: "your question about Property Records data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
