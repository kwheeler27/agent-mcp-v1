# Maintained diagrams

The [architecture](architecture.mmd) follows `src/client.ts` and `src/server.ts`; the [ERD](erd.mmd) follows both CREATE TABLE declarations in `src/seed.ts`, invoked at server startup. There are two tables, nine columns, two autoincrement integer primary keys and no declared foreign keys, unique email constraint or additional indexes. The genre join illustrated in [architecture notes](../architecture.md) is an example query predicate, not a foreign key or guaranteed cardinality.

The query_database tool permits schema-changing SQL, so the seed definition is not proof of current runtime database state. No workspace files, credentials or database contents were opened, and no server was started. These small views are maintained directly against the source declarations; sibling SVGs are validated renders. Existing architecture notes remain the detailed explanation.
