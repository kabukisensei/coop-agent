---
id: powerbi_reports_app_deployment
title: Power BI App Deployment
domain: powerbi
layer: report
artifact: app_deployment
technology: power_bi
status: active
---
# Power BI App Deployment

## Standards

### App logo standards

Create workspace and app logos in Canva: select an existing icon and apply the report theme colors.

## Default positions

### Workspace audience defaults

Organize workspaces by department or user group. The workspace represents the audience.

### App audience defaults

Avoid dividing an app into Power BI audiences; the management overhead is rarely worth it.

### App access defaults

Create one Microsoft Entra ID security group for each Power BI app and use that group to manage app access.

## Open decisions (not standards)

- Security-group naming and ownership.
- How membership is requested, approved, reviewed, and removed.
- Whether the app security group also grants workspace access.
