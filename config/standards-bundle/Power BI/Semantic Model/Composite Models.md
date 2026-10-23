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

A composite model combines content from existing semantic models. One model supplies the shared foundation; secondary models extend it with additional facts.

## Standards

### Composite model structure standards

- Designate exactly one Primary model in each composite-model family.
- Add the Primary model first and each secondary model afterward.
- Take shared dimensions from Primary; add facts from secondary models.
- Keep imported table names unchanged.

### Large dimension validation standards

When a large or high-cardinality dimension is required, validate model size, memory use, and successful deployment before adopting it.

## Default positions

### Composite dimension defaults

Exclude large or high-cardinality dimensions by default; they can cause model-size and memory errors.
