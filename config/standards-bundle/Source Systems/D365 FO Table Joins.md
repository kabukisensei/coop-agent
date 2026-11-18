---
id: source_d365_fo_joins
title: D365 Finance and Operations Table Joins
domain: source
layer: agnostic
artifact: join_map
technology: d365_fo
status: active
---
# D365 Finance and Operations Table Joins

Applies to SQL that joins standard Dynamics 365 Finance and Operations (F&O) tables. It lists the usual key for each pair in the standard Microsoft schema.

## Standards

### Use standards

- Start from this map; never invent a join from a column name. Confirm every column in the live catalog or the Silver table before you use it: a client may not export the table, and custom fields are not listed here.
- Add `dataareaid` to every join between two company-specific tables. A column that ends `(recid)` below holds the other table's `recid`.
- A pair that is not listed is not known. Say so and ask, or confirm the key from the data.

### Sales and receivables joins

| From | To |
|---|---|
| `salesline.salesid` | `salestable.salesid` |
| `salestable.custaccount`, `salestable.invoiceaccount` | `custtable.accountnum` |
| `salesline.itemid` | `inventtable.itemid` |
| `custinvoicetrans` (`salesid`, `invoiceid`, `invoicedate`, `numbersequencegroup`) | `custinvoicejour`, same four columns |
| `custinvoicetrans.inventtransid` | `salesline.inventtransid` |
| `custtrans.accountnum` | `custtable.accountnum` |
| `custtransopen.refrecid` (recid) | `custtrans.recid` |
| `custsettlement.transrecid` (recid) | `custtrans.recid` |

### Purchasing and payables joins

| From | To |
|---|---|
| `purchline.purchid` | `purchtable.purchid` |
| `purchtable.orderaccount`, `purchtable.invoiceaccount` | `vendtable.accountnum` |
| `vendinvoicetrans` (`purchid`, `invoiceid`, `invoicedate`, `numbersequencegroup`, `internalinvoiceid`) | `vendinvoicejour`, same five columns |
| `vendtrans.accountnum` | `vendtable.accountnum` |
| `vendtransopen.refrecid` (recid) | `vendtrans.recid` |
| `vendsettlement.transrecid` (recid) | `vendtrans.recid` |

### Product and inventory joins

| From | To |
|---|---|
| `inventtable.product` (recid) | `ecoresproduct.recid` |
| `ecoresproducttranslation.product` (recid) | `ecoresproduct.recid`, one row per `languageid` |
| `inventitemgroupitem` (`itemid`, `itemdataareaid`) | `inventtable` (`itemid`, `dataareaid`) |
| `inventitemgroupitem` (`itemgroupid`, `itemgroupdataareaid`) | `inventitemgroup` (`itemgroupid`, `dataareaid`) |
| `inventtrans.inventtransorigin` (recid) | `inventtransorigin.recid` |
| `inventtransorigin.inventtransid` | `salesline.inventtransid`, `purchline.inventtransid` |
| `inventtrans.inventdimid`, `inventsum.inventdimid`, order line `inventdimid` | `inventdim.inventdimid` |
| `inventdim.inventsiteid` | `inventsite.siteid` |
| `inventdim.inventlocationid` | `inventlocation.inventlocationid` |

### General ledger joins

| From | To |
|---|---|
| `generaljournalaccountentry.generaljournalentry` (recid) | `generaljournalentry.recid` |
| `generaljournalaccountentry.ledgerdimension` (recid) | `dimensionattributevaluecombination.recid` |
| `generaljournalaccountentry.mainaccount`, `dimensionattributevaluecombination.mainaccount` (recid) | `mainaccount.recid` |
| `generaljournalentry.ledger` (recid) | `ledger.recid` |
| `generaljournalentry.fiscalcalendarperiod` (recid) | `fiscalcalendarperiod.recid` |
| `subledgervouchergeneraljournalentry.generaljournalentry` (recid) | `generaljournalentry.recid` |
| `subledgervouchergeneraljournalentry` (`voucher`, `voucherdataareaid`, `accountingdate`) | A subledger row such as `custtrans` (`voucher`, `dataareaid`, `transdate`) |

- The ledger tables are shared. Reach the company through `ledger`, as the F&O source article says.

### Party and address joins

| From | To |
|---|---|
| `custtable.party`, `vendtable.party`, `hcmworker.person` (recid) | `dirpartytable.recid` |
| `dirpartylocation.party` (recid) | `dirpartytable.recid` |
| `dirpartylocation.location`, `dirpartytable.primaryaddresslocation` (recid) | `logisticslocation.recid` |
| `logisticspostaladdress.location`, `logisticselectronicaddress.location` (recid) | `logisticslocation.recid` |

### Project joins

| From | To |
|---|---|
| `projemptrans.projid`, `projcosttrans.projid`, `projitemtrans.projid`, `projrevenuetrans.projid`, `projonacctrans.projid` | `projtable.projid` |
| `categoryid` on `projemptrans`, `projcosttrans`, `projitemtrans`, `projrevenuetrans` | `projcategory.categoryid` |
| `projtable.custaccount` | `custtable.accountnum` |
