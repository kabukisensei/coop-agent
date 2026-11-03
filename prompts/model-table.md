# /model-table

Use the `coop-workflow` skill.

Help me add a table to a Power BI semantic model and relate it, following our
semantic model standards.

1. **Ask** which semantic model, which SQL table or view to bring in (a gold
   `fact.` or `dim.` object), and whether it is a fact or a dimension in the model.
2. **Look first.** Look up the SQL object's lineage with `data_doc`
   (`command="lineage"`), read its columns from its file or the catalog snapshot,
   and read the model's existing tables and relationships.
3. **Propose** the table and wait for my approval: the partition source (the M
   query), the columns to load and which to hide (keys and technical columns),
   names, descriptions, display folders and sort-by columns, and each relationship
   with its key columns, cardinality and filter direction. Follow the Model
   Metadata, Fact Tables, Relationships and M Query standards you were given.
4. **Apply it** after a backup, then self-check against the same standards, run
   `bpa_review` when Tabular Editor is configured, and tell me what to check in
   Power BI Desktop (refresh, the relationship view, one visual).
