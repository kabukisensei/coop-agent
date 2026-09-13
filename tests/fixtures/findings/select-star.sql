/*
  File: silver/dim_customer.sql
  Purpose: pinned SQL Review golden fixture
*/
CREATE VIEW silver.dim_customer AS
WITH cte_source AS (
    SELECT *  -- intermediate CTE: allowed
    FROM bronze.raw_erp_contact
)
SELECT *      -- production select: flagged
FROM cte_source;
GO

SELECT COUNT(*) AS n FROM silver.dim_customer;
GO
