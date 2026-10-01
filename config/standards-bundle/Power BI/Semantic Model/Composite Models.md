---
id: powerbi_semantic_model_composite_models
title: Power BI Composite Models
domain: powerbi
layer: semantic_model
artifact: composite_model
technology: power_bi
status: active
---
# Composite Models

## Standards

### Composite model structure standards

- Designate exactly one Primary model in each composite-model family.
- Take shared dimensions from Primary; add facts from secondary models afterward.
- Keep imported table names unchanged.

`Finance + Project Accounting`: Finance is Primary; Project Accounting adds facts. For SIOP, Inventory is Primary and Project Management adds facts.

### Large dimension validation standards

When a large or high-cardinality dimension such as Voucher is required, validate model size, memory use, and successful deployment before adopting it.

## Default positions

### Composite dimension defaults

Exclude large or high-cardinality dimensions such as Voucher by default; they can cause model-size and memory errors.

## Open decisions (non-normative)

Whether Production participates in SIOP.
