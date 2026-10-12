"""Optionaler Export: STEP AP242 mit semantischer PMI über die OCAF/XDE-Schnittstelle von OpenCASCADE
(XCAFDoc_DimTolTool + XCAFDimTolObjects_DimensionObject)."""
from OCP.TDocStd import TDocStd_Document
from OCP.TCollection import TCollection_ExtendedString, TCollection_HAsciiString
from OCP.XCAFDoc import XCAFDoc_DocumentTool, XCAFDoc_Dimension
from OCP.XCAFDimTolObjects import (XCAFDimTolObjects_DimensionObject, XCAFDimTolObjects_DimensionType_Size_Diameter,
                                   XCAFDimTolObjects_DimensionType_Size_Radius, XCAFDimTolObjects_DimensionType_Location_LinearDistance,
                                   XCAFDimTolObjects_DimensionType_Location_Angular, XCAFDimTolObjects_DimensionType_DimensionPresentation,
                                   XCAFDimTolObjects_DimensionType_Size_CurveLength, XCAFDimTolObjects_DimensionType_Size_Angular)
from OCP.TDF import TDF_LabelSequence, TDF_Label
from OCP.STEPCAFControl import STEPCAFControl_Writer
from OCP.STEPControl import STEPControl_AsIs
from OCP.Interface import Interface_Static
from OCP.TColStd import TColStd_HArray1OfReal
from OCP.gp import gp_Pnt


def write_ap242(solid, faces, pmi, path):
    try:
        return _write(solid, faces, pmi, path)
    except RuntimeError:
        ok = []
        for it in pmi:
            try:
                _write(solid, faces, ok + [it], path); ok.append(it)
            except RuntimeError:
                pass
        r = _write(solid, faces, ok, path)
        r["uebersprungen"] = [it["id"] for it in pmi if it not in ok]
        return r


def _write(solid, faces, pmi, path):
    doc = TDocStd_Document(TCollection_ExtendedString("XmlXCAF"))
    st = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())
    dt = XCAFDoc_DocumentTool.DimTolTool_s(doc.Main())
    root = st.AddShape(solid.wrapped, False)
    occ_faces = solid.Faces()
    sid2face = {f["sid"]: occ_faces[f["id"]] for f in faces}
    lab_cache = {}
    def sublabel(sid):
        if sid not in lab_cache:
            lab_cache[sid] = st.AddSubShape(root, sid2face[sid].wrapped)
        return lab_cache[sid]
    n = 0
    for it in pmi:
        groups = [g["flaechen"] for g in it["bezuege"] if g["flaechen"]]
        if not groups: continue
        typ = {"Durchmesser": XCAFDimTolObjects_DimensionType_Size_Diameter, "Radius": XCAFDimTolObjects_DimensionType_Size_Radius,
               "Abstand": XCAFDimTolObjects_DimensionType_Location_LinearDistance, "Winkel": XCAFDimTolObjects_DimensionType_Location_Angular,
               "Fase": XCAFDimTolObjects_DimensionType_Location_LinearDistance}.get(it["typ"], XCAFDimTolObjects_DimensionType_Location_LinearDistance)
        if len(groups) == 1 and typ in (XCAFDimTolObjects_DimensionType_Location_LinearDistance, XCAFDimTolObjects_DimensionType_Location_Angular):
            typ = XCAFDimTolObjects_DimensionType_Size_CurveLength if it["typ"] != "Winkel" else XCAFDimTolObjects_DimensionType_Size_Angular
        obj = XCAFDimTolObjects_DimensionObject()
        obj.SetType(typ)
        obj.SetValue(float(it["nennmass"]))
        if it.get("tol_oben") is not None and it.get("tol_unten") is not None:
            obj.SetUpperBound(float(it["nennmass"]) + float(it["tol_oben"]))
            obj.SetLowerBound(float(it["nennmass"]) + float(it["tol_unten"]))
        obj.SetSemanticName(TCollection_HAsciiString(it["id"]))
        p = it["label_3d"]; obj.SetPointTextAttach(gp_Pnt(*p))
        dl = dt.AddDimension()
        dim = XCAFDoc_Dimension.Set_s(dl)
        dim.SetObject(obj)
        first, second = TDF_LabelSequence(), TDF_LabelSequence()
        for sid in groups[0]: first.Append(sublabel(sid))
        if len(groups) > 1:
            for sid in groups[1]: second.Append(sublabel(sid))
        dt.SetDimension(first, second, dl)
        n += 1
    Interface_Static.SetCVal_s("write.step.schema", "AP242DIS")
    w = STEPCAFControl_Writer()
    w.SetDimTolMode(True)
    if not w.Transfer(doc, STEPControl_AsIs): raise RuntimeError("Transfer fehlgeschlagen")
    if w.Write(path) != 1: raise RuntimeError("Schreiben fehlgeschlagen")
    Interface_Static.SetCVal_s("write.step.schema", "AP214IS")
    txt = open(path, errors="ignore").read()
    import re
    m = re.search(r"FILE_SCHEMA\s*\(\s*\(\s*'([^']+)'", txt)
    return dict(schema=m.group(1) if m else "?", pmi_anzahl=n,
                dimensional_size=txt.count("DIMENSIONAL_SIZE"), dimensional_location=txt.count("DIMENSIONAL_LOCATION"))
