# /clean-unused

Use the `coop-workflow` skill.

Help me find tables and columns nothing uses any more and remove them safely.
Read first; every drop or alter waits for my approval, goes to dev only through
the normal write flow, and production is changed by a person, never from here.

1. **Ask** which database or schema to look at and whether I mean whole tables and
   views, columns, or both. The lineage docs must be built (`data_doc`): when they
   come from the live dev database and were read more than 7 days ago, run
   `/setup-docs refresh` first so the lineage is current. No built docs: stop and
   offer `/setup-docs`; without lineage there is no evidence to clean up on.
2. **Find candidates** from the lineage graph, read-only: tables and views with no
   downstream dependents (nothing reads, references or visualizes them), and for
   tables that are used, columns no view, procedure, measure or report reads
   (`data_doc` with `command="lineage"` per object; the manifest's column lists).
   Then ask `sql_impact` on dev for every candidate: the live catalog's dependents
   and the columns each one `uses` are the gate. A column that `sql_impact` shows in
   use, or an object with any dependent, is not a candidate.
3. **Say what the docs cannot see**: notebooks, pipelines, dataflows, dynamic SQL,
   ad hoc queries and reports outside the documented folders. A candidate is
   "unused in what is documented", not proven unused; name the person who owns
   each one and what to ask them.
4. **Report** one numbered list, most certain first: the object or column, the
   evidence (the `data_doc` and `sql_impact` output that shows no dependents),
   what the docs cannot see for it, and the proposed step: rename or deprecate
   first, or drop. Write it up with `/spec-first` and wait for me to pick numbers.
5. **Change dev only**, one approved item at a time with `/slice-next`: the
   smallest statement, back up any file that defines the object, verify with
   `sql_impact` again after the change, and show me the diff. Then run
   `schema_compare` between dev and the next environment so the promotion script
   is ready for review; promoting it is a person's step.
6. Finish with what to watch: reports that error, and the next weekly "what
   changed in dev" summary in `live/dev-changes.md` when the docs read dev.
