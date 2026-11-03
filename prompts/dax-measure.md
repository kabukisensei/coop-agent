# /dax-measure

Use the `coop-workflow` skill.

Help me add or fix a DAX measure in a Power BI semantic model, following our DAX
and Measure Metadata standards.

1. **Ask** which semantic model, the measure's name (or the one to fix), what
   business question it answers in one sentence, and how it should behave in a
   total row and under a date filter.
2. **Look first.** Read the model's tables, relationships and existing measures
   that this one could build on, and look up the measure or its tables with
   `data_doc` (`command="lineage"`) to see which reports use it.
3. **Propose** the DAX and its metadata (name, home table, display folder, format
   string, description, visibility) and explain each filter or iterator in plain
   words. Follow the DAX standards you were given: structure and variables, the
   CALCULATE filter patterns, totals, averages, SUMMARIZE grouping and the
   function rules. Wait for my approval before editing the model file.
4. **Apply it** after a backup, then self-check against the same standards and
   give me two or three values to verify in Power BI Desktop (a total, one slice,
   an edge case such as a blank period).
