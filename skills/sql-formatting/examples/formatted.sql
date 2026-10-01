-- Worked example of coop's default T-SQL layout: the coop-standards SQL Layout
-- article where it speaks (six-space select lists with the comma one column left,
-- five-space CTE names, JOIN aligned with FROM, ON four spaces under the join, AND
-- four spaces under WHERE or ON, one WHEN per line), the Cooptimize SQL Prompt
-- style for everything else (uppercase keywords, expanded statement parentheses,
-- aligned aliases, = on its own line in assignments, semicolons).
-- Where this file and the rules in SKILL.md disagree, SKILL.md wins.

DECLARE @Company NVARCHAR(4)
    = N'usmf';

SET @Company
    = UPPER(@Company);

WITH
     ActiveCustomers AS
     (
         SELECT
               ct.dataareaid
              ,ct.accountnum
              ,ct.name
         FROM d365fo.custtable AS ct
         WHERE ct.blocked = 0
             AND ct.dataareaid = @Company
     )
    ,SalesOrders AS
     (
         SELECT
               st.dataareaid
              ,st.salesid
              ,st.custaccount
              ,st.createddatetime
         FROM d365fo.salestable AS st
         WHERE st.salesstatus IN ( 1, 2 )
     )
SELECT TOP (100)
      ac.accountnum                      AS Customer         -- source key, kept as-is
     ,ac.name                            AS [Customer Name]
     ,COUNT(so.salesid)                  AS [Order Count]
     ,MAX(so.createddatetime)            AS [Latest Order]
     ,CASE
          WHEN COUNT(so.salesid) = 0 THEN 'No orders'
          WHEN MAX(so.createddatetime) >= DATEADD(DAY, -30, SYSDATETIME()) THEN 'Active'
          ELSE 'Dormant'
      END                                AS [Customer Status]
FROM ActiveCustomers AS ac
LEFT JOIN SalesOrders AS so
    ON ac.dataareaid = so.dataareaid
        AND ac.accountnum = so.custaccount
GROUP BY
      ac.accountnum
     ,ac.name
ORDER BY
      [Order Count] DESC
     ,ac.accountnum;

-- A statement shorter than 75 characters stays on one line.
SELECT COUNT(*) AS [Customer Count] FROM dim.Customer AS cust;

CREATE TABLE dim.Customer
(
      CustomerKey  INT           NOT NULL IDENTITY(1, 1)
     ,Customer     NVARCHAR(20)  NOT NULL
     ,CustomerName NVARCHAR(100) NULL
     ,CONSTRAINT PK_dim_Customer
          PRIMARY KEY CLUSTERED (CustomerKey)
);

INSERT INTO dim.Customer
(
      Customer
     ,CustomerName
)
VALUES
(
      N'C001'
     ,N'Contoso'
);
