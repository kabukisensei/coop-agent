# /clean-model

Use the `coop-workflow` skill.

Help me clean up a Power BI semantic model against our standards. Read first, fix
only what I approve.

1. **Ask** which semantic model (the `.SemanticModel` folder, TMDL or `.bim` file)
   and whether there is a part to focus on. Look up the model's lineage with
   `data_doc` (`command="lineage"`) so we know which reports use it.
2. **Review it** against the semantic model standards you were given (Model
   Metadata, Measure Metadata, Relationships, Fact Tables, DAX, M Query,
   Composite Models). Check table and column naming, hidden key and technical
   columns, descriptions, display folders, sort-by columns and hierarchies, the
   date table, relationship keys, cardinality and filter direction, measure
   naming, format strings and visibility, and DAX patterns. Run `bpa_review` too
   when Tabular Editor is configured.
3. **Report** one numbered list, most important first: what is wrong, where
   (table, column or measure), the standard section it comes from, and the fix.
   Group the purely cosmetic items at the end. Flag any fix that could break a
   report visual (a rename or a removed field) and name the reports from the
   lineage.
4. **Wait for me to pick** which numbers to fix. Back up the files, then apply
   only those, one group at a time, and show me the diff after each.
5. Finish with a self-check against the same standards and anything I should
   check in Power BI Desktop before I publish.
