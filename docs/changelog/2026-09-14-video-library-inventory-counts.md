# Video status counts the complete library

The previous status response reported 1,917 total videos but counted only the first 1,000 when constructing its source breakdown. The route now reads `fn_video_library_scrape_inventory()`, which computes all counts in one database snapshot. Unassigned videos are reported explicitly, and malformed or inconsistent counts produce a failed response instead of a healthy-looking partial inventory.

The latest scrape also exposes its recorded full/source scope. Older reports without scope return null. Status reads still create no execution or freshness receipt.

Prerequisite: Club Arena migration `20260914050300_video_library_inventory_counts.sql`. Native PostgreSQL tests cover the actual aggregate and permissions; route tests cover more than 1,000 rows, unusual source names, missing/inconsistent results, and scrape scope.
