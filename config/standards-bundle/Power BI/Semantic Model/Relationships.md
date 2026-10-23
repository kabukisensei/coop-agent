---
id: powerbi_semantic_model_relationships
title: Power BI Relationships
domain: powerbi
layer: semantic_model
artifact: relationship
technology: power_bi
status: active
---
# Relationships

## Standards

### Relationship key standards

- Define the fact first and dimension second, with `N:1` cardinality.
- Use `int64` relationship keys, hide them, and set summarization to none.

```text
Sales[FKCustomer] → Customer[PKCustomer] (N:1)
```

### Impossible relationship standards

Use an `FKNULL` relationship to record that a fact and dimension cannot conceptually be joined. In the model diagram, this distinguishes an impossible relationship from one that is merely missing and provides a permanent record that every potential relationship was considered.

Never use `FKNULL` to replace a valid relationship with missing, incomplete, or unmatched keys.

Relate the fact's `FKNULL` column to the dimension key. This prevents a visual from repeating the fact result for every member of an unrelated dimension and is more efficient than leaving the relationship absent. Keep the relationship active so the fact summarizes under the blank/null member.

Adding this after deployment can change report results. Regression-test affected reports before deployment.

```text
Sales[FKNULL] → UnrelatedDimension[PKDimension] (N:1)
```
