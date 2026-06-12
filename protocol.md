# Protocol 

Here's the complete protocol, which is everything you need to write your own pushes (just run the encode side in reverse):

**Session**
- `00 20 00 01 04 20091210` — VERIFY, unlocks writes with the fixed secret.
- `00 A4 04 00 07 D2760000850101` — SELECT the NDEF Type-4 app.
- `00 D1 00 00 00` — returns a BER-TLV blob (serial `SEAB018773`, dimensions, etc.); optional. `F0 D8 …` reads device strings like "4_color Screen"; also optional.

**Image write** — repeat per strip, `F0 D3 00 P2 Lc [block] [sub] <lzo fragment>`:
- The panel is 400×300, sent as **15 horizontal strips** (`block` = `0x00`–`0x0e`, 20 rows each).
- Each strip is packed to **2 bpp, MSB-first, rows stored right-to-left** (so build the strip, flip it horizontally, then pack), giving 2000 bytes, then **LZO1X-compressed** 
- That compressed stream is split into fragments of ≤250 payload bytes; `sub` counts them from 0. `P2 = 0x00` means "more fragments follow for this block," `P2 = 0x01` marks the **last** fragment of the block. `Lc` = 2 + fragment length.
- Color codes: `0 = black, 1 = white, 2 = yellow, 3 = red`.

**Refresh**
- `F0 D4 85 80 00` — triggers the panel update.
- `F0 DE 00 00 01` — poll repeatedly (returns a status byte + `90 00`) until the refresh completes; this is why the log has ~180 of them, since BWRY updates take a while.