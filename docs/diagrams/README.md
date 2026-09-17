# Maintained diagrams

The [architecture](architecture.mmd) follows `src/client.ts` and `src/server.ts`; the [ERD](erd.mmd) follows both CREATE TABLE declarations in `src/seed.ts`, invoked at server startup. There are two tables, nine columns, two autoincrement integer primary keys and no declared foreign keys, unique email constraint or additional indexes. The genre join illustrated in [architecture notes](../architecture.md) is an example query predicate, not a foreign key or guaranteed cardinality.

The query_database tool permits schema-changing SQL, so the seed definition is not proof of current runtime database state. No workspace files, credentials or database contents were opened, and no server was started. These small views are maintained directly against the source declarations; sibling SVGs are validated renders. Existing architecture notes remain the detailed explanation.

## Field descriptions and table layout

The SVG exports show **Field → Description → Type → PK/FK → Required**. Each displayed field has a one-line description in [field-descriptions.json](field-descriptions.json). Schema definitions and the planning contract remain authoritative for types, keys, and nullability. `Yes` means non-null, `No` means nullable, `Conditional` refers to the condition in the description, and `Unspecified` preserves an undecided contract. These indicators describe stored values, not whether callers must supply values with defaults. PK/FK are key membership; existing UK markers are retained. A dash means no key marker in this view, not proof that no other constraint exists.

Mermaid's native ERD renderer fixes its column order. The `.mmd` files retain valid Mermaid grammar and descriptions in comments; use `scripts/render-erd.ts` to produce the five-column SVG exports with the same relationships and cardinalities. The renderer changes presentation only and never writes a database or schema. It uses an existing Mermaid CLI installation (tested with version 11.17.0); set `MERMAID_CLI_ROOT` to that package directory if it is installed outside the repository. No application dependency is added.

Refresh descriptions, then render:

```sh
node --experimental-strip-types scripts/erd-fields.ts --write docs/diagrams/erd.mmd
node --experimental-strip-types scripts/erd-fields.ts --check docs/diagrams/erd.mmd
node --experimental-strip-types scripts/render-erd.ts docs/diagrams/erd.mmd
```

The renderer checks description freshness and fails on a missing description or insufficient table width. Existing PNG exports are refreshed too; set `ERD_PNG=1` to create them. Large PNGs are capped at 12,000 pixels on their longest side; the SVG retains full resolution. Inspect the SVG exports, especially dense overview diagrams.
