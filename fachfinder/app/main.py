"""Fachfinder – virtuelle Sortierkästen mit 3D-Ansicht.

Backend: FastAPI + SQLite (eine Datei, keine weitere Datenbank nötig).
Start:   uvicorn main:app --host 0.0.0.0 --port 8099
"""
from __future__ import annotations

import json
import re
import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import List, Optional

from fastapi import FastAPI, HTTPException, Response
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator

BASE = Path(__file__).resolve().parent
STATIC = BASE / "static"
DB_PATH = Path(os.environ.get("FACHFINDER_DB", BASE / "data" / "fachfinder.db"))

APP_VERSION = "1.1.0"  # muss zu APP_VERSION in static/app.js passen
MAX_GRID = 40

SCHEMA = """
CREATE TABLE IF NOT EXISTS areas(
    id        INTEGER PRIMARY KEY,
    parent_id INTEGER REFERENCES areas(id) ON DELETE CASCADE,
    name      TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS boxes(
    id          INTEGER PRIMARY KEY,
    area_id     INTEGER NOT NULL REFERENCES areas(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    rows        INTEGER NOT NULL DEFAULT 4,
    cols        INTEGER NOT NULL DEFAULT 6,
    width       REAL NOT NULL DEFAULT 400,
    depth       REAL NOT NULL DEFAULT 300,
    height      REAL NOT NULL DEFAULT 60,
    orientation TEXT NOT NULL DEFAULT 'liegend',
    color       TEXT NOT NULL DEFAULT '#4f7cac',
    notes       TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS cells(
    id       INTEGER PRIMARY KEY,
    box_id   INTEGER NOT NULL REFERENCES boxes(id) ON DELETE CASCADE,
    row_i    INTEGER NOT NULL,
    col_i    INTEGER NOT NULL,
    row_span INTEGER NOT NULL DEFAULT 1,
    col_span INTEGER NOT NULL DEFAULT 1,
    label    TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS items(
    id      INTEGER PRIMARY KEY,
    cell_id INTEGER NOT NULL REFERENCES cells(id) ON DELETE CASCADE,
    name    TEXT NOT NULL,
    qty     TEXT NOT NULL DEFAULT '',
    notes   TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS tags(
    id        INTEGER PRIMARY KEY,
    name      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    parent_id INTEGER REFERENCES tags(id) ON DELETE SET NULL,
    color     TEXT NOT NULL DEFAULT '#6c8ebf',
    synonyms  TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS item_tags(
    item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    tag_id  INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY(item_id, tag_id)
);
CREATE INDEX IF NOT EXISTS ix_boxes_area ON boxes(area_id);
CREATE INDEX IF NOT EXISTS ix_cells_box ON cells(box_id);
CREATE INDEX IF NOT EXISTS ix_items_cell ON items(cell_id);
"""


def _connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys=ON")
    return con


@contextmanager
def db():
    con = _connect()
    try:
        yield con
        con.commit()
    except Exception:
        con.rollback()
        raise
    finally:
        con.close()


def _migrate(con):
    """Ergänzt neue Spalten in bestehenden Datenbanken (ältere Versionen bleiben kompatibel)."""
    def cols(t):
        return {r[1] for r in con.execute(f"PRAGMA table_info({t})")}
    add = {
        "cells": [("sub_rows", "INTEGER NOT NULL DEFAULT 1"), ("sub_cols", "INTEGER NOT NULL DEFAULT 1")],
        "items": [("slot", "INTEGER NOT NULL DEFAULT 0"), ("links", "TEXT NOT NULL DEFAULT '[]'"),
                  ("props", "TEXT NOT NULL DEFAULT '[]'")],
    }
    for table, columns in add.items():
        have = cols(table)
        for name, decl in columns:
            if name not in have:
                con.execute(f"ALTER TABLE {table} ADD COLUMN {name} {decl}")


with db() as _c:
    _c.executescript(SCHEMA)
    _migrate(_c)

app = FastAPI(title="Fachfinder", docs_url="/api/docs", redoc_url=None)


# --------------------------------------------------------------------------- models
class AreaIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    parent_id: Optional[int] = None


class AreaPatch(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=120)
    parent_id: Optional[int] = None


class BoxIn(BaseModel):
    area_id: int
    name: str = Field(min_length=1, max_length=120)
    rows: int = Field(default=4, ge=1, le=MAX_GRID)
    cols: int = Field(default=6, ge=1, le=MAX_GRID)
    width: float = Field(default=400, gt=0, le=10000)
    depth: float = Field(default=300, gt=0, le=10000)
    height: float = Field(default=60, gt=0, le=10000)
    orientation: str = Field(default="liegend", pattern="^(liegend|stehend)$")
    color: str = Field(default="#4f7cac", pattern="^#[0-9a-fA-F]{6}$")
    notes: str = ""


class BoxPatch(BaseModel):
    area_id: Optional[int] = None
    name: Optional[str] = Field(default=None, min_length=1, max_length=120)
    width: Optional[float] = Field(default=None, gt=0, le=10000)
    depth: Optional[float] = Field(default=None, gt=0, le=10000)
    height: Optional[float] = Field(default=None, gt=0, le=10000)
    orientation: Optional[str] = Field(default=None, pattern="^(liegend|stehend)$")
    color: Optional[str] = Field(default=None, pattern="^#[0-9a-fA-F]{6}$")
    notes: Optional[str] = None


class LayoutCell(BaseModel):
    id: Optional[int] = None
    row: int = Field(ge=0)
    col: int = Field(ge=0)
    rowspan: int = Field(default=1, ge=1)
    colspan: int = Field(default=1, ge=1)
    label: str = ""


class LayoutIn(BaseModel):
    rows: int = Field(ge=1, le=MAX_GRID)
    cols: int = Field(ge=1, le=MAX_GRID)
    cells: List[LayoutCell]


MAX_SUB = 12


class CellPatch(BaseModel):
    label: Optional[str] = Field(default=None, max_length=120)
    sub_rows: Optional[int] = Field(default=None, ge=1, le=MAX_SUB)
    sub_cols: Optional[int] = Field(default=None, ge=1, le=MAX_SUB)


class Link(BaseModel):
    type: str = Field(default="link", pattern="^(datenblatt|shop|konfig|doku|link)$")
    label: str = Field(default="", max_length=120)
    url: str = Field(min_length=1, max_length=2000)

    @field_validator("url")
    @classmethod
    def _http_only(cls, v: str) -> str:
        v = v.strip()
        if "://" not in v:
            v = "https://" + v
        if not v.lower().startswith(("http://", "https://")):
            raise ValueError("Nur http(s)-Links erlaubt")
        return v


class Prop(BaseModel):
    k: str = Field(min_length=1, max_length=80)
    v: str = Field(default="", max_length=300)


TAG_COLORS = ["#4f7cac", "#c2553b", "#5b8c4a", "#8a5bb5", "#c9a227", "#2e8b8b", "#b8577a", "#6b7a8f"]


class TagIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    parent_id: Optional[int] = None
    color: Optional[str] = Field(default=None, pattern="^#[0-9a-fA-F]{6}$")
    synonyms: str = Field(default="", max_length=400)


class TagPatch(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=80)
    parent_id: Optional[int] = None
    color: Optional[str] = Field(default=None, pattern="^#[0-9a-fA-F]{6}$")
    synonyms: Optional[str] = Field(default=None, max_length=400)


class ItemIn(BaseModel):
    cell_id: int
    slot: int = Field(default=0, ge=0)
    name: str = Field(min_length=1, max_length=200)
    qty: str = ""
    notes: str = ""
    links: List[Link] = []
    props: List[Prop] = []
    tags: List[int] = []


class ItemPatch(BaseModel):
    cell_id: Optional[int] = None
    slot: Optional[int] = Field(default=None, ge=0)
    name: Optional[str] = Field(default=None, min_length=1, max_length=200)
    qty: Optional[str] = None
    notes: Optional[str] = None
    links: Optional[List[Link]] = None
    props: Optional[List[Prop]] = None
    tags: Optional[List[int]] = None


# --------------------------------------------------------------------------- helpers
def _patch(con, table: str, row_id: int, data: dict):
    if not data:
        return
    sets = ", ".join(f"{k}=?" for k in data)
    cur = con.execute(f"UPDATE {table} SET {sets} WHERE id=?", [*data.values(), row_id])
    if cur.rowcount == 0:
        raise HTTPException(404, "Nicht gefunden")


def _exists(con, table: str, row_id: int) -> bool:
    return con.execute(f"SELECT 1 FROM {table} WHERE id=?", (row_id,)).fetchone() is not None


def _create_default_cells(con, box_id: int, rows: int, cols: int):
    con.executemany(
        "INSERT INTO cells(box_id,row_i,col_i) VALUES(?,?,?)",
        [(box_id, r, c) for r in range(rows) for c in range(cols)],
    )


def _item_dict(r) -> dict:
    d = dict(r)
    for k in ("links", "props"):
        try:
            d[k] = json.loads(d.get(k) or "[]")
        except ValueError:
            d[k] = []
    return d


def _items_with_tags(con) -> list:
    tags: dict[int, list[int]] = {}
    for r in con.execute("SELECT item_id, tag_id FROM item_tags"):
        tags.setdefault(r["item_id"], []).append(r["tag_id"])
    out = []
    for r in con.execute("SELECT * FROM items"):
        d = _item_dict(r)
        d["tags"] = tags.get(d["id"], [])
        out.append(d)
    return out


def _set_item_tags(con, item_id: int, tag_ids: list[int]):
    con.execute("DELETE FROM item_tags WHERE item_id=?", (item_id,))
    for t in dict.fromkeys(tag_ids):
        if not _exists(con, "tags", t):
            raise HTTPException(400, "Label existiert nicht")
        con.execute("INSERT INTO item_tags(item_id, tag_id) VALUES(?,?)", (item_id, t))


_SQUASH = re.compile(r"[^0-9a-zäöüß]+")


def _squash(s: str) -> str:
    return _SQUASH.sub("", s.lower())


def matches(words: list[str], hay: str) -> bool:
    """Alle Suchwörter müssen vorkommen – normal oder ohne Sonderzeichen
    (so findet „dcdc“ auch „DC/DC“ und „stepdown“ auch „Step-Down“)."""
    h, hs = hay.lower(), _squash(hay)
    return all(w in h or (_squash(w) and _squash(w) in hs) for w in words)


def _tag_terms(con) -> dict[int, str]:
    """Pro Label: eigene Namen + Synonyme und die aller übergeordneten Labels."""
    tags = {r["id"]: dict(r) for r in con.execute("SELECT * FROM tags")}
    out = {}
    for tid in tags:
        parts, seen, t = [], set(), tags.get(tid)
        while t and t["id"] not in seen:
            seen.add(t["id"])
            parts += [t["name"], t["synonyms"]]
            t = tags.get(t["parent_id"])
        out[tid] = " ".join(parts)
    return out


def _valid_slot(con, cell_id: int, slot: int) -> int:
    row = con.execute("SELECT sub_rows, sub_cols FROM cells WHERE id=?", (cell_id,)).fetchone()
    if row is None:
        raise HTTPException(400, "Fach existiert nicht")
    return slot if 0 <= slot < row["sub_rows"] * row["sub_cols"] else 0


def _all_data(con) -> dict:
    return {
        "areas": [dict(r) for r in con.execute("SELECT id,parent_id,name FROM areas")],
        "boxes": [dict(r) for r in con.execute("SELECT * FROM boxes")],
        "cells": [
            dict(r)
            for r in con.execute(
                "SELECT id,box_id,row_i AS row,col_i AS col,row_span AS rowspan,"
                "col_span AS colspan,label,sub_rows,sub_cols FROM cells"
            )
        ],
        "items": _items_with_tags(con),
        "tags": [dict(r) for r in con.execute("SELECT * FROM tags")],
    }


# --------------------------------------------------------------------------- API
@app.get("/api/health")
def health():
    return {"ok": True, "version": APP_VERSION}


@app.get("/api/data")
def get_data():
    with db() as con:
        return _all_data(con)


@app.get("/api/export")
def export():
    with db() as con:
        data = _all_data(con)
    name = f"fachfinder-{datetime.now():%Y%m%d-%H%M}.json"
    return Response(
        json.dumps(data, ensure_ascii=False, indent=2),
        media_type="application/json",
        headers={"Content-Disposition": f'attachment; filename="{name}"'},
    )


@app.post("/api/import")
def import_data(data: dict):
    """Ersetzt ALLE Daten durch einen Export (JSON). Vorher wird automatisch eine
    Sicherung der Datenbank daneben abgelegt (fachfinder.db.bak-JJJJMMTT-HHMMSS)."""
    for key in ("areas", "boxes", "cells", "items"):
        if not isinstance(data.get(key), list):
            raise HTTPException(400, f"Keine gültige Fachfinder-Exportdatei (‚{key}‘ fehlt)")
    tags = data.get("tags") or []

    def topo(rows):
        """Eltern vor Kindern einfügen; unbekannte/zyklische Eltern werden zur obersten Ebene."""
        ids = {r["id"] for r in rows}
        done, out, pending = set(), [], list(rows)
        while pending:
            progressed = False
            for r in pending[:]:
                p = r.get("parent_id")
                if p is None or p in done or p not in ids:
                    out.append(dict(r, parent_id=p if p in done else None))
                    done.add(r["id"]); pending.remove(r); progressed = True
            if not progressed:
                out += [dict(r, parent_id=None) for r in pending]
                break
        return out

    # Sicherung der aktuellen Datenbank
    backup = DB_PATH.with_name(f"{DB_PATH.name}.bak-{datetime.now():%Y%m%d-%H%M%S}")
    src, dst = _connect(), sqlite3.connect(backup)
    try:
        src.backup(dst)
    finally:
        dst.close(); src.close()
    for old in sorted(DB_PATH.parent.glob(f"{DB_PATH.name}.bak-*"))[:-5]:  # nur die 5 neuesten behalten
        old.unlink(missing_ok=True)

    try:
        with db() as con:
            for t in ("item_tags", "items", "cells", "boxes", "areas", "tags"):
                con.execute(f"DELETE FROM {t}")
            for a in topo(data["areas"]):
                con.execute("INSERT INTO areas(id,parent_id,name) VALUES(?,?,?)", (a["id"], a["parent_id"], a["name"]))
            for t in topo(tags):
                con.execute("INSERT INTO tags(id,name,parent_id,color,synonyms) VALUES(?,?,?,?,?)",
                            (t["id"], t["name"], t["parent_id"], t.get("color") or "#6c8ebf", t.get("synonyms") or ""))
            for b in data["boxes"]:
                con.execute(
                    "INSERT INTO boxes(id,area_id,name,rows,cols,width,depth,height,orientation,color,notes) "
                    "VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                    (b["id"], b["area_id"], b["name"], b.get("rows", 4), b.get("cols", 6), b.get("width", 400),
                     b.get("depth", 300), b.get("height", 60), b.get("orientation", "liegend"),
                     b.get("color", "#4f7cac"), b.get("notes", "")))
            for c in data["cells"]:
                con.execute(
                    "INSERT INTO cells(id,box_id,row_i,col_i,row_span,col_span,label,sub_rows,sub_cols) "
                    "VALUES(?,?,?,?,?,?,?,?,?)",
                    (c["id"], c["box_id"], c["row"], c["col"], c.get("rowspan", 1), c.get("colspan", 1),
                     c.get("label", ""), c.get("sub_rows", 1), c.get("sub_cols", 1)))
            tag_ids = {t["id"] for t in tags}
            for i in data["items"]:
                con.execute(
                    "INSERT INTO items(id,cell_id,slot,name,qty,notes,links,props) VALUES(?,?,?,?,?,?,?,?)",
                    (i["id"], i["cell_id"], i.get("slot", 0), i["name"], i.get("qty", ""), i.get("notes", ""),
                     json.dumps(i.get("links") or [], ensure_ascii=False),
                     json.dumps(i.get("props") or [], ensure_ascii=False)))
                for t in dict.fromkeys(i.get("tags") or []):
                    if t in tag_ids:
                        con.execute("INSERT INTO item_tags(item_id,tag_id) VALUES(?,?)", (i["id"], t))
    except (KeyError, TypeError, sqlite3.IntegrityError) as e:
        raise HTTPException(400, f"Exportdatei ist unvollständig oder beschädigt ({e.__class__.__name__}: {e}). "
                                 "Es wurde nichts geändert.")
    return {"ok": True, "areas": len(data["areas"]), "boxes": len(data["boxes"]),
            "items": len(data["items"]), "tags": len(tags), "backup": backup.name}


# ---- Bereiche
@app.post("/api/areas")
def create_area(a: AreaIn):
    with db() as con:
        if a.parent_id is not None and not _exists(con, "areas", a.parent_id):
            raise HTTPException(400, "Übergeordneter Bereich existiert nicht")
        cur = con.execute("INSERT INTO areas(name,parent_id) VALUES(?,?)", (a.name.strip(), a.parent_id))
        return {"id": cur.lastrowid}


@app.patch("/api/areas/{area_id}")
def update_area(area_id: int, a: AreaPatch):
    data = a.model_dump(exclude_unset=True)
    with db() as con:
        if "parent_id" in data and data["parent_id"] is not None:
            # Zyklen verhindern: neuer Parent darf nicht der Bereich selbst oder ein Unterbereich sein
            p = data["parent_id"]
            while p is not None:
                if p == area_id:
                    raise HTTPException(400, "Ein Bereich kann nicht in sich selbst liegen")
                row = con.execute("SELECT parent_id FROM areas WHERE id=?", (p,)).fetchone()
                if row is None:
                    raise HTTPException(400, "Übergeordneter Bereich existiert nicht")
                p = row["parent_id"]
        _patch(con, "areas", area_id, data)
    return {"ok": True}


@app.delete("/api/areas/{area_id}")
def delete_area(area_id: int):
    with db() as con:
        con.execute("DELETE FROM areas WHERE id=?", (area_id,))
    return {"ok": True}


# ---- Kästen
@app.post("/api/boxes")
def create_box(b: BoxIn):
    with db() as con:
        if not _exists(con, "areas", b.area_id):
            raise HTTPException(400, "Bereich existiert nicht")
        d = b.model_dump()
        d["name"] = d["name"].strip()
        cols = ", ".join(d)
        cur = con.execute(f"INSERT INTO boxes({cols}) VALUES({', '.join('?' * len(d))})", list(d.values()))
        _create_default_cells(con, cur.lastrowid, b.rows, b.cols)
        return {"id": cur.lastrowid}


@app.patch("/api/boxes/{box_id}")
def update_box(box_id: int, b: BoxPatch):
    data = b.model_dump(exclude_unset=True)
    with db() as con:
        if "area_id" in data and not _exists(con, "areas", data["area_id"]):
            raise HTTPException(400, "Bereich existiert nicht")
        _patch(con, "boxes", box_id, data)
    return {"ok": True}


@app.delete("/api/boxes/{box_id}")
def delete_box(box_id: int):
    with db() as con:
        con.execute("DELETE FROM boxes WHERE id=?", (box_id,))
    return {"ok": True}


@app.put("/api/boxes/{box_id}/layout")
def set_layout(box_id: int, lay: LayoutIn):
    """Setzt Raster + Fachaufteilung. Fächer, die wegfallen (z. B. beim Verbinden
    oder Verkleinern), geben ihren Inhalt an das Fach ab, das jetzt ihre Position abdeckt.
    Es geht also nie etwas verloren."""
    rows, cols = lay.rows, lay.cols
    grid: list[list[Optional[int]]] = [[None] * cols for _ in range(rows)]
    for idx, c in enumerate(lay.cells):
        if c.row + c.rowspan > rows or c.col + c.colspan > cols:
            raise HTTPException(400, "Fach liegt außerhalb des Rasters")
        for r in range(c.row, c.row + c.rowspan):
            for k in range(c.col, c.col + c.colspan):
                if grid[r][k] is not None:
                    raise HTTPException(400, "Fächer überlappen sich")
                grid[r][k] = idx
    if any(v is None for line in grid for v in line):
        raise HTTPException(400, "Raster ist nicht vollständig mit Fächern belegt")

    with db() as con:
        if not _exists(con, "boxes", box_id):
            raise HTTPException(404, "Kasten nicht gefunden")
        old = {r["id"]: r for r in con.execute("SELECT * FROM cells WHERE box_id=?", (box_id,))}
        new_ids: list[int] = []
        used: set[int] = set()
        for c in lay.cells:
            if c.id in old and c.id not in used:
                con.execute(
                    "UPDATE cells SET row_i=?,col_i=?,row_span=?,col_span=?,label=? WHERE id=?",
                    (c.row, c.col, c.rowspan, c.colspan, c.label, c.id),
                )
                new_ids.append(c.id)
                used.add(c.id)
            else:
                cur = con.execute(
                    "INSERT INTO cells(box_id,row_i,col_i,row_span,col_span,label) VALUES(?,?,?,?,?,?)",
                    (box_id, c.row, c.col, c.rowspan, c.colspan, c.label),
                )
                new_ids.append(cur.lastrowid)
        for oid, o in old.items():
            if oid in used:
                continue
            target = new_ids[grid[min(o["row_i"], rows - 1)][min(o["col_i"], cols - 1)]]
            con.execute("UPDATE items SET cell_id=?, slot=0 WHERE cell_id=?", (target, oid))
            con.execute("DELETE FROM cells WHERE id=?", (oid,))
        con.execute("UPDATE boxes SET rows=?, cols=? WHERE id=?", (rows, cols, box_id))
    return {"ok": True}


# ---- Fächer
@app.patch("/api/cells/{cell_id}")
def update_cell(cell_id: int, c: CellPatch):
    """Beschriftung und Trenner-Raster eines Fachs. Ändert sich das Trenner-Raster,
    bleiben Teile an ihrer Position (bzw. rutschen in den nächstgelegenen Bereich)."""
    data = c.model_dump(exclude_unset=True)
    if "label" in data:
        data["label"] = (data["label"] or "").strip()
    with db() as con:
        old = con.execute("SELECT sub_rows, sub_cols FROM cells WHERE id=?", (cell_id,)).fetchone()
        if old is None:
            raise HTTPException(404, "Fach nicht gefunden")
        _patch(con, "cells", cell_id, data)
        nr, nc = data.get("sub_rows", old["sub_rows"]), data.get("sub_cols", old["sub_cols"])
        if (nr, nc) != (old["sub_rows"], old["sub_cols"]):
            for it in con.execute("SELECT id, slot FROM items WHERE cell_id=?", (cell_id,)).fetchall():
                r, k = divmod(it["slot"], old["sub_cols"])
                new = min(r, nr - 1) * nc + min(k, nc - 1)
                con.execute("UPDATE items SET slot=? WHERE id=?", (new, it["id"]))
    return {"ok": True}


# ---- Inhalte
@app.post("/api/items")
def create_item(i: ItemIn):
    with db() as con:
        slot = _valid_slot(con, i.cell_id, i.slot)
        cur = con.execute(
            "INSERT INTO items(cell_id,slot,name,qty,notes,links,props) VALUES(?,?,?,?,?,?,?)",
            (i.cell_id, slot, i.name.strip(), i.qty.strip(), i.notes.strip(),
             json.dumps([l.model_dump() for l in i.links], ensure_ascii=False),
             json.dumps([p.model_dump() for p in i.props], ensure_ascii=False)),
        )
        if i.tags:
            _set_item_tags(con, cur.lastrowid, i.tags)
        return {"id": cur.lastrowid}


@app.patch("/api/items/{item_id}")
def update_item(item_id: int, i: ItemPatch):
    data = {k: (v.strip() if isinstance(v, str) else v) for k, v in i.model_dump(exclude_unset=True).items()}
    tag_ids = data.pop("tags", None)
    for k in ("links", "props"):
        if k in data:
            data[k] = json.dumps(data[k] or [], ensure_ascii=False)
    with db() as con:
        cur = con.execute("SELECT cell_id, slot FROM items WHERE id=?", (item_id,)).fetchone()
        if cur is None:
            raise HTTPException(404, "Nicht gefunden")
        if "cell_id" in data or "slot" in data:
            cell = data.get("cell_id", cur["cell_id"])
            slot = data.get("slot", 0 if "cell_id" in data else cur["slot"])
            data["slot"] = _valid_slot(con, cell, slot)
        _patch(con, "items", item_id, data)
        if tag_ids is not None:
            _set_item_tags(con, item_id, tag_ids)
    return {"ok": True}


# ---- Labels
def _check_tag_parent(con, tag_id: Optional[int], parent_id: Optional[int]):
    p = parent_id
    while p is not None:
        if p == tag_id:
            raise HTTPException(400, "Ein Label kann nicht unter sich selbst liegen")
        row = con.execute("SELECT parent_id FROM tags WHERE id=?", (p,)).fetchone()
        if row is None:
            raise HTTPException(400, "Übergeordnetes Label existiert nicht")
        p = row["parent_id"]


@app.post("/api/tags")
def create_tag(t: TagIn):
    name = t.name.strip()
    with db() as con:
        row = con.execute("SELECT id FROM tags WHERE name=?", (name,)).fetchone()
        if row:
            return {"id": row["id"], "existing": True}
        _check_tag_parent(con, None, t.parent_id)
        n = con.execute("SELECT COUNT(*) FROM tags").fetchone()[0]
        cur = con.execute(
            "INSERT INTO tags(name,parent_id,color,synonyms) VALUES(?,?,?,?)",
            (name, t.parent_id, t.color or TAG_COLORS[n % len(TAG_COLORS)], t.synonyms.strip()),
        )
        return {"id": cur.lastrowid}


@app.patch("/api/tags/{tag_id}")
def update_tag(tag_id: int, t: TagPatch):
    data = {k: (v.strip() if isinstance(v, str) else v) for k, v in t.model_dump(exclude_unset=True).items()}
    with db() as con:
        if "parent_id" in data:
            _check_tag_parent(con, tag_id, data["parent_id"])
        if "name" in data:
            dup = con.execute("SELECT id FROM tags WHERE name=? AND id<>?", (data["name"], tag_id)).fetchone()
            if dup:
                raise HTTPException(400, "Ein Label mit diesem Namen gibt es schon")
        _patch(con, "tags", tag_id, data)
    return {"ok": True}


@app.delete("/api/tags/{tag_id}")
def delete_tag(tag_id: int):
    """Unter-Labels rutschen eine Ebene nach oben, die Teile verlieren nur dieses Label."""
    with db() as con:
        row = con.execute("SELECT parent_id FROM tags WHERE id=?", (tag_id,)).fetchone()
        if row is None:
            raise HTTPException(404, "Nicht gefunden")
        con.execute("UPDATE tags SET parent_id=? WHERE parent_id=?", (row["parent_id"], tag_id))
        con.execute("DELETE FROM tags WHERE id=?", (tag_id,))
    return {"ok": True}


@app.delete("/api/items/{item_id}")
def delete_item(item_id: int):
    with db() as con:
        con.execute("DELETE FROM items WHERE id=?", (item_id,))
    return {"ok": True}


# ---- Suche (für Home Assistant / Skripte; die Oberfläche sucht selbst im Browser)
@app.get("/api/search")
def search(q: str):
    words = [w.lower() for w in q.split() if w]
    if not words:
        return []
    with db() as con:
        terms = _tag_terms(con)
        item_tags: dict[int, list[int]] = {}
        for r in con.execute("SELECT item_id, tag_id FROM item_tags"):
            item_tags.setdefault(r["item_id"], []).append(r["tag_id"])
        tag_names = {r["id"]: r["name"] for r in con.execute("SELECT id, name FROM tags")}
        rows = con.execute(
            """SELECT i.id, i.name, i.qty, i.notes, i.slot, i.links, i.props, c.id AS cell_id, c.row_i, c.col_i,
                      c.label, c.sub_rows, c.sub_cols, b.id AS box_id, b.name AS box, a.name AS area
               FROM items i JOIN cells c ON c.id=i.cell_id JOIN boxes b ON b.id=c.box_id
               JOIN areas a ON a.id=b.area_id"""
        ).fetchall()
    out = []
    for r in rows:
        it = _item_dict(r)
        props = " ".join(f"{p.get('k', '')} {p.get('v', '')}" for p in it["props"])
        links = " ".join(l.get("label", "") for l in it["links"])
        tids = item_tags.get(r["id"], [])
        tagtxt = " ".join(terms.get(t, "") for t in tids)
        hay = f"{r['name']} {r['qty']} {r['notes']} {r['label']} {props} {links} {tagtxt}"
        if matches(words, hay):
            code = _row_letter(r["row_i"]) + str(r["col_i"] + 1)
            if r["sub_rows"] * r["sub_cols"] > 1:
                code += f".{r['slot'] + 1}"
            out.append({
                "item": r["name"], "qty": r["qty"], "area": r["area"], "box": r["box"],
                "fach": code, "box_id": r["box_id"], "cell_id": r["cell_id"], "slot": r["slot"],
                "links": it["links"], "props": it["props"], "tags": [tag_names[t] for t in tids],
                "link": f"#box={r['box_id']}&cell={r['cell_id']}&slot={r['slot']}",
            })
    return out


def _row_letter(i: int) -> str:
    s, i = "", i + 1
    while i > 0:
        i, m = divmod(i - 1, 26)
        s = chr(65 + m) + s
    return s


# ---- Beispieldaten
@app.post("/api/demo")
def demo():
    with db() as con:
        if con.execute("SELECT COUNT(*) FROM areas").fetchone()[0]:
            raise HTTPException(400, "Datenbank ist nicht leer")
        werk = con.execute("INSERT INTO areas(name) VALUES('Werkstatt')").lastrowid
        wand = con.execute("INSERT INTO areas(name,parent_id) VALUES('Lochwand links',?)", (werk,)).lastrowid
        schrank = con.execute("INSERT INTO areas(name,parent_id) VALUES('Schrank',?)", (werk,)).lastrowid

        def box(area, name, rows, cols, w, d, h, ori, color):
            bid = con.execute(
                "INSERT INTO boxes(area_id,name,rows,cols,width,depth,height,orientation,color) VALUES(?,?,?,?,?,?,?,?,?)",
                (area, name, rows, cols, w, d, h, ori, color),
            ).lastrowid
            _create_default_cells(con, bid, rows, cols)
            return bid

        def put(bid, r, c, *items, label="", sub=None):
            cid = con.execute("SELECT id FROM cells WHERE box_id=? AND row_i=? AND col_i=?", (bid, r, c)).fetchone()[0]
            if label:
                con.execute("UPDATE cells SET label=? WHERE id=?", (label, cid))
            if sub:
                con.execute("UPDATE cells SET sub_rows=?, sub_cols=? WHERE id=?", (*sub, cid))
            for it in items:
                if isinstance(it, dict):
                    con.execute(
                        "INSERT INTO items(cell_id,slot,name,qty,notes,links,props) VALUES(?,?,?,?,?,?,?)",
                        (cid, it.get("slot", 0), it["name"], it.get("qty", ""), it.get("notes", ""),
                         json.dumps(it.get("links", []), ensure_ascii=False),
                         json.dumps(it.get("props", []), ensure_ascii=False)))
                    continue
                name, qty = it if isinstance(it, tuple) else (it, "")
                con.execute("INSERT INTO items(cell_id,name,qty) VALUES(?,?,?)", (cid, name, qty))

        b1 = box(schrank, "Schrauben metrisch", 4, 6, 380, 290, 55, "liegend", "#3d6fa8")
        put(b1, 0, 0, ("M3 Zylinderschraube DIN 912", "ca. 100"), label="M3 x 10")
        put(b1, 0, 1, ("M3 Mutter DIN 934", "ca. 200"))
        put(b1, 0, 2, ("M4 Zylinderschraube DIN 912", "ca. 80"), label="M4 x 12")
        put(b1, 0, 3, ("M4 Mutter DIN 934", "ca. 150"))
        put(b1, 1, 0, ("M5 Senkkopf DIN 7991", "50"))
        put(b1, 1, 1, ("U-Scheiben M3–M5", "Mix"))
        put(b1, 2, 4, ("Einschraubmuttern M3 (3D-Druck)", "100"))
        put(b1, 3, 0, {"name": "Kabelbinder 100 mm", "qty": "ca. 200", "slot": 0},
            {"name": "Kabelbinder 200 mm", "qty": "ca. 100", "slot": 1},
            {"name": "Klett-Kabelbinder", "qty": "20", "slot": 2}, sub=(3, 1))

        b2 = box(wand, "SMD-Magazin", 5, 4, 300, 260, 140, "stehend", "#c2553b")
        put(b2, 0, 0, ("Widerstände 0805 E12", "Sortiment"))
        put(b2, 0, 1, ("Kondensatoren 0805", "Sortiment"))
        put(b2, 1, 0, {"name": "ESP32-C6 Module", "qty": "6",
                       "links": [{"type": "datenblatt", "label": "Datenblatt",
                                  "url": "https://www.espressif.com/sites/default/files/documentation/esp32-c6_datasheet_en.pdf"}],
                       "props": [{"k": "Funk", "v": "WLAN 6, BLE 5, Zigbee/Thread"}, {"k": "Versorgung", "v": "3,3 V"}]})
        put(b2, 1, 1, {"name": "INA219 Breakout", "qty": "4",
                       "links": [{"type": "datenblatt", "label": "TI INA219", "url": "https://www.ti.com/lit/ds/symlink/ina219.pdf"},
                                 {"type": "konfig", "label": "ESPHome", "url": "https://esphome.io/components/sensor/ina219.html"}],
                       "props": [{"k": "Bus", "v": "I²C, Adresse 0x40–0x4F"}, {"k": "Shunt", "v": "0,1 Ω"}]})
        put(b2, 3, 0, {"name": "LM2596 Step-Down (DC/DC)", "qty": "3", "slot": 0,
                       "links": [{"type": "datenblatt", "label": "TI LM2596", "url": "https://www.ti.com/lit/ds/symlink/lm2596.pdf"}],
                       "props": [{"k": "Eingang", "v": "4,5–40 V"}, {"k": "Ausgang", "v": "1,2–37 V, max. 3 A"}]},
            {"name": "MT3608 Step-Up", "qty": "5", "slot": 1, "props": [{"k": "Eingang", "v": "2–24 V"}]},
            sub=(1, 2), label="DC/DC-Wandler")
        put(b2, 2, 2, ("Wago 221-413", "50"), ("Wago 221-415", "30"))

        b3 = box(wand, "Kabelkram", 2, 3, 360, 200, 120, "stehend", "#5b8c4a")
        put(b3, 0, 0, ("USB-C Kabel", "5"))
        put(b3, 1, 2, ("Aderendhülsen 0,75–2,5 mm²", "Box"))
        put(b2, 0, 2, {"name": "LM7805 Festspannungsregler", "qty": "10",
                       "links": [{"type": "datenblatt", "label": "TI LM7805", "url": "https://www.ti.com/lit/ds/symlink/lm7805.pdf"}],
                       "props": [{"k": "Ausgang", "v": "5 V, max. 1,5 A"}, {"k": "Gehäuse", "v": "TO-220"}]})

        # Labels mit Hierarchie und Synonymen
        def tag(name, parent=None, color="#6c8ebf", syn=""):
            return con.execute("INSERT INTO tags(name,parent_id,color,synonyms) VALUES(?,?,?,?)",
                               (name, parent, color, syn)).lastrowid
        sv = tag("Spannungsversorgung", None, "#c9a227", "Spannungswandler, Regler, Netzteil, Stromversorgung")
        lin = tag("Linearregler", sv, "#c9a227", "LDO, Festspannungsregler")
        sch = tag("Schaltregler (DC/DC)", sv, "#c2553b", "DCDC, DC-DC, Wandler")
        sd = tag("Step-Down", sch, "#c2553b", "Buck, Abwärtswandler")
        su = tag("Step-Up", sch, "#c2553b", "Boost, Aufwärtswandler")
        mcu = tag("Mikrocontroller", None, "#4f7cac", "MCU, µC, Controller")
        sens = tag("Sensor", None, "#2e8b8b", "Messen, Messung")
        funk = tag("Funk", None, "#8a5bb5", "WLAN, WiFi, Zigbee, Bluetooth, BLE, Thread")
        bef = tag("Befestigung", None, "#6b7a8f", "Schraube, Mutter, Kleinteile")

        def assign(item_name, *tids):
            iid = con.execute("SELECT id FROM items WHERE name=?", (item_name,)).fetchone()[0]
            con.executemany("INSERT INTO item_tags(item_id,tag_id) VALUES(?,?)", [(iid, t) for t in tids])
        assign("LM2596 Step-Down (DC/DC)", sd)
        assign("MT3608 Step-Up", su)
        assign("LM7805 Festspannungsregler", lin)
        assign("ESP32-C6 Module", mcu, funk)
        assign("INA219 Breakout", sens)
        for n in ("M3 Zylinderschraube DIN 912", "M3 Mutter DIN 934", "M4 Zylinderschraube DIN 912",
                  "M4 Mutter DIN 934", "M5 Senkkopf DIN 7991", "U-Scheiben M3–M5"):
            assign(n, bef)
    return {"ok": True}


# --------------------------------------------------------------------------- Frontend
app.mount("/static", StaticFiles(directory=STATIC), name="static")


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html", headers={"Cache-Control": "no-cache"})


# --------------------------------------------------------------------------- Direktstart
if __name__ == "__main__":
    # Start mit:  python main.py   (Port über Umgebungsvariable PORT änderbar)
    import uvicorn

    port = int(os.environ.get("PORT", 8099))
    print(f"Fachfinder läuft auf http://localhost:{port}  (Beenden mit Strg+C)")
    uvicorn.run(app, host="0.0.0.0", port=port)
