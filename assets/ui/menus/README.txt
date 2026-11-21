BREAD LEADERBOARD — Phaser 3 assets

Static: board_static.png (includes header, parchment, close art).
Reusable: row_normal.png for positions 2-10; row_highlighted.png for #1.
Rank medals: rank_1_gold.png / rank_2_silver.png / rank_3_bronze.png; rank_plain.png for 4+.
Draw numbers for positions 4+ and all usernames and scores dynamically with Phaser Text.
Score marker: bread_score_icon.png.
Scrollbar: scroll_track.png (fixed), scroll_thumb.png (draggable, reposition based on offset).
EXAMPLE_10_scores.png: composition preview, not a game-ready background texture.

10 rows are visible at once. Scrollbar becomes useful if the backend returns more than 10 players; scrolling moves the viewport of 10 rows. Close button remains part of the static board and should use a Phaser interactive hit area.

Transparent RGBA PNGs. The preview uses arbitrary demonstration names/scores.
