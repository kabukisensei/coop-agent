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

### Inactive relationship standards

Every inactive relationship needs an intentional `USERELATIONSHIP()` consumer. Remove inactive relationships with no consumer.

```dax
USERELATIONSHIP(FactSales[FKShipDate], 'Date'[PKDate])
```

### FKNULL relationship standards

Use `FKNULL` only when the fact and dimension cannot conceptually be joined. Never use it to replace a valid relationship with missing, incomplete, or unmatched keys.

Relate the fact's `FKNULL` column to the dimension key. Without a relationship, a visual can repeat the fact result for each dimension member. An active `FKNULL` relationship summarizes it under the blank/null member.

Adding this after deployment can change report results. Regression-test affected reports before deployment.

```text
Sales[FKNULL] → UnrelatedDimension[PKDimension] (N:1)
```

## Default positions

### Model shape defaults

Use a star schema with flat dimensions. Avoid chains through intermediate dimension tables unless an approved project requirement overrides this shape.

### Filter direction defaults

Avoid physical bidirectional relationships. Use `CROSSFILTER` in the measure when temporary bidirectional filtering is needed, unless an approved project override requires a physical relationship.

### FKNULL activation defaults

Make `FKNULL` relationships active.
