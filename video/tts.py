"""VO for one scene: tts.py <text-file> <out.mp3> <out.json>. Writes the mp3 and {"words": [[start_s, end_s, word], ...]}."""
import asyncio, json, sys
import edge_tts

VOICE = "en-US-AndrewNeural"


async def main(txt, mp3, out):
    text = open(txt, encoding="utf-8").read().strip()
    words = []
    com = edge_tts.Communicate(text, VOICE, rate="+4%", boundary="WordBoundary")
    with open(mp3, "wb") as f:
        async for c in com.stream():
            if c["type"] == "audio":
                f.write(c["data"])
            elif c["type"] == "WordBoundary":
                s = c["offset"] / 1e7
                words.append([s, s + c["duration"] / 1e7, c["text"]])
    json.dump({"words": words}, open(out, "w", encoding="utf-8"))


asyncio.run(main(*sys.argv[1:4]))
