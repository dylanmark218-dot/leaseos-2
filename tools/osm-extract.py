"""
Walk an .osm.pbf and write the line-delimited intermediate that `server/_core/osmLoad.ts` consumes.

A tool, deliberately not product code. Reading protobuf-inside-zlib well means a parser, a
dependency and a 350 MB fixture; keeping that out here leaves the loader testable with four lines of
text, and leaves the extract itself something a person can read, diff and attach to a bug report.

    python3 tools/osm-extract.py alberta.osm.pbf out.ndjson MINLON MINLAT MAXLON MAXLAT
    sha256sum out.ndjson          # record this against the build

Writes one JSON object per way: id, tags, node ids, coordinates. Nothing derived and nothing
filtered on the loader's behalf beyond the bounding box and the highway classes, because a decision
made here is a decision the loader's tests cannot see.

Requires: pip install osmium
"""
import osmium, json, sys
VEH = {"motorway","trunk","primary","secondary","tertiary","unclassified","residential","living_street",
       "service","track","road","motorway_link","trunk_link","primary_link","secondary_link","tertiary_link"}
NON = {"footway","cycleway","path","pedestrian","steps","bridleway","corridor","via_ferrata",
       "elevator","platform","raceway","proposed","construction"}
minlon,minlat,maxlon,maxlat = [float(x) for x in sys.argv[3:7]]
out=open(sys.argv[2],"w"); n=0
class E(osmium.SimpleHandler):
    def way(self, w):
        global n
        hw=w.tags.get("highway")
        if not hw or (hw not in VEH and hw not in NON): return
        try: pts=[(nd.lon,nd.lat) for nd in w.nodes if nd.location.valid()]
        except Exception: return
        if len(pts)<2 or len(pts)!=len(w.nodes): return
        if not any(minlon<=x<=maxlon and minlat<=y<=maxlat for x,y in pts): return
        out.write(json.dumps({"id":w.id,"tags":dict(w.tags),
                              "nodes":[nd.ref for nd in w.nodes],
                              "geometry":[[round(x,6),round(y,6)] for x,y in pts]})+"\n")
        n+=1
e=E(); e.apply_file(sys.argv[1], locations=True, idx="flex_mem")
out.close(); print(n)
