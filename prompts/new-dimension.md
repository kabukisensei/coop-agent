# /new-dimension

Use the `coop-workflow` skill.

Help me set up a new gold dimension table in SQL. Guide me one step at a time and
do not write anything until I approve the spec.

1. **Ask first**, in one short list: the business entity (customer, item, account),
   its business key, the source tables or views, the attributes people filter and
   group by, and whether it needs history. Ask which folder or repository the SQL
   lives in when the project file does not say.
2. **Look before you design.** Read each source's file (SQL repository, then the
   catalog snapshot) and its lineage with `data_doc` (`command="lineage"`). Run
   `sql_impact` before touching any live object. Check whether a `dim.<Name>`
   already covers this entity and tell me before making a second one.
3. **Write a spec with `/spec-first`** and wait for my approval: table name, every
   column with type and nullability, the key the facts match on, how unknown or
   missing members are handled, the display fields, and the gold load (view or
   stored procedure) that fills it.
4. **Build it** following the Gold Dimension Tables, Gold Views and Gold Stored
   Procedures standards you were given: `dim` schema, PascalCase names, the
   matching and nullability rules, display-field rules, and a load that never
   leaves an empty or partial table. Mark each SQL edit with the coop comment line.
5. **Self-check** the files against the same standards, name any deviation and its
   reason, and tell me how to prove on dev that the business key is unique.
6. List the facts that should get an `FK{DimensionName}` column for it, and offer
   `/model-table` to add it to the semantic model.
