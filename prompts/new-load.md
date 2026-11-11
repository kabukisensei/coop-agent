# /new-load

Use the `coop-workflow` skill.

Help me build or change a SQL load: a silver table from a source system, or a gold
view or stored procedure. Guide me one step at a time and do not write anything
until I approve the spec.

1. **Ask** which layer (silver or gold), the object to create or change, its
   sources, and what it should produce. Ask which folder or repository the SQL
   lives in when the project file does not say.
2. **Look first.** Read the object's file and each source's file (SQL repository,
   then the catalog snapshot), and its lineage with `data_doc`
   (`command="lineage"`). Run `sql_impact` before changing any live object, and
   list what downstream would need to change too.
3. **Write a spec with `/spec-first`** and wait for my approval: the columns, the
   joins and filters, how duplicates, late rows and nulls are handled, and how the
   load is verified on dev.
4. **Build it** following the standards you were given for that layer: Silver
   Tables (source structure, Schema Manager, approved developer changes), Gold
   Views (naming, fields, transformations) or Gold Stored Procedures (removal,
   gather, transformation, write and comment rules, no empty or partial tables),
   plus SQL Conventions and SQL Layout. Keep it lean: no `TRY`/`CATCH`, `THROW` or
   defensive checks unless the project's standards ask. Mark each SQL edit with the coop comment
   line.
5. **Self-check** against the same standards, name any deviation and its reason,
   and give me the queries that prove the result on dev, as separate test queries,
   never inside the object.
