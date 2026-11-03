# /new-fact

Use the `coop-workflow` skill.

Help me set up a new gold fact table in SQL (and, if I want it, its table in the
semantic model). Guide me one step at a time and do not write anything until I
approve the spec.

1. **Ask first**, in one short list: what business process the fact records, its
   grain (one row per what), the source tables or views it loads from, the
   dimensions it joins to, and the measures (amounts, quantities) it carries.
   Ask which folder or repository the SQL lives in when the project file does not
   say.
2. **Look before you design.** For each source, read its file (SQL repository,
   then the catalog snapshot), then its lineage with `data_doc`
   (`command="lineage"`). Run `sql_impact` before touching any live object. Tell
   me which dimensions already exist (`dim.<Name>`) and which are missing.
3. **Write a spec with `/spec-first`** and wait for my approval: table name, grain,
   every column with type and nullability, the `FK{DimensionName}` columns and how
   each is matched to its dimension, the indexes, and the gold load (view or
   stored procedure) that fills it.
4. **Build it** following the Gold Fact Tables, Gold Views and Gold Stored
   Procedures standards you were given: `fact` schema, PascalCase names,
   `FK{DimensionName}` references, nullable columns by default, no identity column
   without a reason, non-unique indexes on join columns, and a load that never
   leaves an empty or partial table. Mark each SQL edit with the coop comment line.
5. **Self-check** the files against the same standards, name any deviation and its
   reason, and tell me how to verify the row count and grain on dev.
6. If I want it in the model, continue with `/model-table`.
