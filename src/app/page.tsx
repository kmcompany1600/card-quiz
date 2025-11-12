"use client";

import React, { useMemo, useRef, useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import { Upload, Check, RotateCcw, Download, Settings, Image as ImageIcon, Trophy, User2 } from "lucide-react";
import * as Papa from "papaparse";

/**
 * カード相場クイズ Webアプリ（単一ファイル版）
 * - データ: CSV/JSONインポート (IMG_URL, NAME, PSA, PRICE, ACTIVE, ALIASES)
 * - 出題: ランダム（間違いの多いカードは重み付けで出やすく）
 * - 回答: 名前・価格（±許容％可変）
 * - 採点: 部分一致 + エイリアス、数字は全角半角/カンマ対応
 * - 保存: ローカル保存（ユーザー名別の履歴/スコア、CSVエクスポート）
 * - UI: モバイル最適、でかボタン、ショートカット（Enter=採点、Ctrl+Enter=次へ）
 */

// ---------- 型 ----------
/** @typedef {{ id:string, img:string, name:string, psa?:string|number, price:number, active?:boolean, aliases?:string[] }} Card */
/** @typedef {{ ts:number, user:string, cardId:string, answeredName:string, answeredPrice:number, correct:boolean, nameOk:boolean, priceOk:boolean, correctName:string, correctPrice:number }} Result */

// ---------- ユーティリティ ----------
const toHalf = (s: string = ""): string => {
  return s
    .replace(/[０-９]/g, (d: string) => String.fromCharCode(d.charCodeAt(0) - 0xFEE0))
    .replace(/[，]/g, ",")
    .replace(/[＋]/g, "+");
};

const norm = (s: string = ""): string => {
  return toHalf(s).trim().toLowerCase().replace(/[\s　]/g, "");
};

const parsePrice = (v: unknown): number => {
  if (v === null || v === undefined) return NaN;
  const s = toHalf(String(v)).replace(/[,円]/g, "");
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
};

const uid = (): string => Math.random().toString(36).slice(2);


// ---------- ストレージ ----------
type Card = {
  id: string;
  name: string;
  psa: number;          // ← 数値に変更（10 など）
  price: number;
  img: string;
  active?: boolean;     // ← CSV等で使っていたら拾えるように
  aliases?: string[];   // ← 名前の別名があれば
};

type Result = {
  id: string;
  correct: boolean;
  date: string;
};

type Store = {
  user: string;
  cards: Card[];
  missMap: Record<string, number>;
  results: Result[];
  tolPct: number;
  strictName: boolean;
  psaFilter: "all" | "10" | "9以下";
};

const LS_KEY = "card-quiz-v1";

function loadStore(): Partial<Store> {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) || "{}");
  } catch {
    return {};
  }
}

function saveStore(data: Partial<Store>): void {
  localStorage.setItem(LS_KEY, JSON.stringify(data));
}

// ---------- 初期デモデータ ----------
const demoCards = /** @type {Card[]} */ ([
  { id: uid(), img: "https://images.pokemontcg.io/swsh45/sv107_hires.png", name: "リザードン VMAX", psa: 10, price: 58000, active: true, aliases:["リザバナ","charizard"] },
  { id: uid(), img: "https://images.pokemontcg.io/base1/4_hires.png", name: "ピカチュウ プロモ", psa: 10, price: 32000, active: true, aliases:["pikachu","プロモ"] },
  { id: uid(), img: "https://images.pokemontcg.io/base1/2_hires.png", name: "フシギバナ", psa: 10, price: 42000, active: true, aliases:["venusaur","バナ"] },
]);

// --------- 重み付きランダム ---------
function weightedPick<T>(items: T[], weights: number[]): T {
  if (items.length !== weights.length || items.length === 0) {
    throw new Error("weightedPick: items と weights の長さ不一致 or 空配列");
  }
  const total = weights.reduce((a: number, b: number) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i];
    if (r <= 0) return items[i];
  }
  // 端数の安全策
  return items[items.length - 1];
}


export default function App(){
  // 状態
  const [user, setUser] = useState( () => loadStore().user || "社員A" );
  const [cards, setCards] = useState( /** @type {Card[]} */ () => loadStore().cards || demoCards );
  const [missMap, setMissMap] = useState( /** @type {Record<string, number>} */ () => loadStore().missMap || {} );
  const [results, setResults] = useState( /** @type {Result[]} */ () => loadStore().results || [] );
  const [tolPct, setTolPct] = useState( () => loadStore().tolPct ?? 10 );
  const [strictName, setStrictName] = useState( () => loadStore().strictName ?? false );
  const [psaFilter, setPsaFilter] = useState( /** @type{"all"|"10"|"9以下"} */ () => loadStore().psaFilter || "all" );
  const [current, setCurrent] = useState( /** @type {Card|null} */ (null) );
  const [ansName, setAnsName] = useState("");
  const [ansPrice, setAnsPrice] = useState("");
  const [showAnswer, setShowAnswer] = useState(false);
  const nameRef = useRef(null);

  // 永続化
  useEffect(()=>{ saveStore({ user, cards, missMap, results, tolPct, strictName, psaFilter }); }, [user, cards, missMap, results, tolPct, strictName, psaFilter]);

  // 出題ロジック
  const filtered = useMemo(()=>{
    return cards.filter(c => c.active !== false).filter(c => {
      if (psaFilter === "10") return String(c.psa||"") === "10";
      if (psaFilter === "9以下") return String(c.psa||"") !== "10";
      return true;
    });
  }, [cards, psaFilter]);

  function nextQuestion() {
    if (!filtered.length){ toast("カードがありません。データをインポートしてください。"); return; }
    const weights = filtered.map(c => 1 + (missMap[c.id] || 0)); // ミス多いほど重みUP
    const pick = weightedPick(filtered, weights);
    setCurrent(pick);
    setAnsName("");
    setAnsPrice("");
    setShowAnswer(false);
    setTimeout(()=>{ nameRef.current?.focus?.(); }, 60);
  }

  useEffect(()=>{ if (!current && filtered.length) nextQuestion(); }, [filtered]);

  // 採点
  function grade(){
    if (!current) return;
    const correctName = current.name;
    const correctPrice = Number(current.price);
    const p = parsePrice(ansPrice);
    const nm = norm(ansName);

    if (!nm || Number.isNaN(p)){
      toast("名前と価格を入力してください");
      return;
    }

    // 名前照合: 厳格 or 部分一致 + エイリアス
    const candidates = [correctName, ...(current.aliases||[])].map(norm);
    const nameOk = strictName ? candidates.includes(nm) : candidates.some(x => nm.includes(x) || x.includes(nm));

    const priceOk = Math.abs(p - correctPrice) <= correctPrice * (tolPct/100);
    const ok = nameOk && priceOk;

    setResults(prev => [{
      ts: Date.now(), user, cardId: current.id,
      answeredName: ansName, answeredPrice: p,
      correct: ok, nameOk, priceOk,
      correctName, correctPrice
    }, ...prev].slice(0, 2000));

    setMissMap(prev => ({ ...prev, [current.id]: (prev[current.id] || 0) + (ok?0:1) }));
    setShowAnswer(true);
    if (ok) toast.success("正解！"); else toast.error("不正解");
  }

  // CSV / JSON インポート
  function importCSV(file){
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (res) => {
        try {
          const rows = res.data || [];
          const mapped = rows.map((r, i) => ({
            id: uid(),
            img: r.IMG_URL || r.img || r.image || "",
            name: (r.NAME||r.name||"").toString(),
            psa: r.PSA || r.psa || "",
            price: parsePrice(r.PRICE||r.price||0),
            active: String(r.ACTIVE||r.active||"true").toLowerCase() !== "false",
            aliases: (r.ALIASES||r.aliases||"").toString().split(/[,、\s]+/).filter(Boolean)
          })).filter(x => x.name && Number.isFinite(x.price));
          if (!mapped.length) throw new Error("有効な行がありません");
          setCards(mapped);
          setMissMap({});
          toast.success(`読み込み: ${mapped.length} 件`);
          setCurrent(null); // 再出題
        } catch(e){ toast.error("CSV読み込み失敗: "+ e.message); }
      },
      error: (e) => toast.error("CSV解析エラー: "+ e.message)
    });
  }

  function importJSON(text){
    try{
      const arr = JSON.parse(text);
      if (!Array.isArray(arr)) throw new Error("配列JSONを渡してください");
      /** @type {Card[]} */
      const mapped = arr.map(x=> ({
        id: uid(), img: x.img||x.IMG_URL, name: x.name||x.NAME,
        psa: x.psa||x.PSA, price: parsePrice(x.price||x.PRICE),
        active: x.active ?? x.ACTIVE ?? true,
        aliases: x.aliases || x.ALIASES || []
      })).filter(x=> x.name && Number.isFinite(x.price));
      if (!mapped.length) throw new Error("有効な行がありません");
      setCards(mapped); setMissMap({}); setCurrent(null);
      toast.success(`読み込み: ${mapped.length} 件`);
    }catch(e){ toast.error("JSON読み込み失敗: "+ e.message); }
  }

  // エクスポート
  function exportResults(){
    const csv = Papa.unparse(results.map(r=>({
      ts: new Date(r.ts).toISOString(), user: r.user,
      cardId: r.cardId, answeredName: r.answeredName,
      answeredPrice: r.answeredPrice, correct: r.correct,
      nameOk: r.nameOk, priceOk: r.priceOk,
      correctName: r.correctName, correctPrice: r.correctPrice
    })));
    const blob = new Blob([csv], {type:"text/csv;charset=utf-8;"});
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `quiz_results_${Date.now()}.csv`;
    a.click(); URL.revokeObjectURL(url);
  }

  // キー操作
  useEffect(()=>{
    const onKey=(e)=>{
      if (e.key === "Enter" && !e.ctrlKey) { e.preventDefault(); grade(); }
      if (e.key === "Enter" && e.ctrlKey) { e.preventDefault(); nextQuestion(); }
    };
    window.addEventListener("keydown", onKey);
    return ()=> window.removeEventListener("keydown", onKey);
  }, [grade, nextQuestion]);

  // 集計
  const summary = useMemo(()=>{
    const mine = results.filter(r=>r.user===user);
    const total = mine.length;
    const correct = mine.filter(r=>r.correct).length;
    const rate = total? Math.round(correct/total*100): 0;
    const last5 = mine.slice(0,5);
    return { total, correct, rate, last5 };
  }, [results, user]);

  return (
    <div className="min-h-screen bg-gray-50 p-4 md:p-8">
      <div className="mx-auto max-w-5xl grid gap-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Trophy className="h-6 w-6"/>
            <h1 className="text-2xl md:text-3xl font-bold">カード相場クイズ</h1>
          </div>
          <div className="flex items-center gap-2">
            <User2 className="h-5 w-5"/>
            <Input value={user} onChange={e=>setUser(e.target.value)} className="w-36" placeholder="ユーザー名"/>
          </div>
        </div>

        <Tabs defaultValue="play" className="w-full">
          <TabsList className="grid grid-cols-3 w-full">
            <TabsTrigger value="play">クイズ</TabsTrigger>
            <TabsTrigger value="settings"><Settings className="h-4 w-4 mr-1"/>設定</TabsTrigger>
            <TabsTrigger value="history">履歴</TabsTrigger>
          </TabsList>

          {/* クイズ */}
          <TabsContent value="play">
            <div className="grid md:grid-cols-2 gap-6">
              <Card className="overflow-hidden">
                <CardHeader>
                  <CardTitle>問題</CardTitle>
                </CardHeader>
                <CardContent>
                  {current ? (
                    <div className="grid gap-4">
                      <div className="aspect-square bg-white rounded-2xl border grid place-items-center overflow-hidden">
                        {current.img ? (
                          <img src={current.img} alt={current.name} className="object-contain w-full h-full"/>
                        ) : (
                          <div className="text-gray-400 flex flex-col items-center">
                            <ImageIcon className="h-10 w-10 mb-2"/>
                            画像なし
                          </div>
                        )}
                      </div>
                      <div className="grid gap-3">
                        <div className="grid gap-2">
                          <Label>カード名</Label>
                          <Input ref={nameRef} value={ansName} onChange={e=>setAnsName(e.target.value)} placeholder="例：リザードン VMAX" className="h-12 text-lg"/>
                        </div>
                        <div className="grid gap-2">
                          <Label>相場（円）</Label>
                          <Input value={ansPrice} onChange={e=>setAnsPrice(e.target.value)} inputMode="numeric" placeholder="例：58000" className="h-12 text-lg"/>
                        </div>
                        <div className="flex gap-3 pt-2">
                          <Button size="lg" className="flex-1" onClick={grade}><Check className="mr-2 h-4 w-4"/>採点（Enter）</Button>
                          <Button size="lg" variant="secondary" className="flex-1" onClick={nextQuestion}><RotateCcw className="mr-2 h-4 w-4"/>次の問題（Ctrl+Enter）</Button>
                        </div>
                      </div>
                      <AnimatePresence>
                        {showAnswer && (
                          <motion.div initial={{opacity:0, y:-6}} animate={{opacity:1, y:0}} exit={{opacity:0}} className="p-4 rounded-xl bg-gray-100 border">
                            <div className="text-sm text-gray-600">正解</div>
                            <div className="font-semibold text-lg">{current.name} / {current.psa?`PSA${current.psa} / `:""}{current.price.toLocaleString()} 円</div>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                  ) : (
                    <div className="h-72 grid place-items-center text-gray-500">カードを読み込み中…</div>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>成績</CardTitle>
                </CardHeader>
                <CardContent className="grid gap-4">
                  <div className="grid grid-cols-3 gap-3 text-center">
                    <div className="p-3 rounded-xl bg-white border">
                      <div className="text-sm text-gray-500">回答</div>
                      <div className="text-2xl font-bold">{summary.total}</div>
                    </div>
                    <div className="p-3 rounded-xl bg-white border">
                      <div className="text-sm text-gray-500">正解</div>
                      <div className="text-2xl font-bold">{summary.correct}</div>
                    </div>
                    <div className="p-3 rounded-xl bg-white border">
                      <div className="text-sm text-gray-500">正答率</div>
                      <div className="text-2xl font-bold">{summary.rate}%</div>
                    </div>
                  </div>
                  <div>
                    <div className="text-sm text-gray-500 mb-2">直近（{summary.last5.length}）</div>
                    <div className="grid gap-2">
                      {summary.last5.map((r,i)=> (
                        <div key={i} className="text-sm p-2 rounded-lg border bg-white flex items-center justify-between">
                          <div className="truncate mr-2">{r.correct?"✅":"❌"} {r.correctName} / {r.correctPrice.toLocaleString()}円</div>
                          <div className="text-gray-600">→ {r.answeredName} / {r.answeredPrice.toLocaleString()}円</div>
                        </div>
                      ))}
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          {/* 設定 */}
          <TabsContent value="settings">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle>データ & ルール</CardTitle>
                <div className="flex gap-2">
                  <Button variant="outline" onClick={exportResults}><Download className="h-4 w-4 mr-2"/>履歴CSV出力</Button>
                  <Button variant="destructive" onClick={()=>{ if(confirm("すべての履歴を削除します。よろしいですか？")){ setResults([]); setMissMap({}); toast("履歴をクリアしました");}}}>リセット</Button>
                </div>
              </CardHeader>
              <CardContent className="grid md:grid-cols-2 gap-6">
                <div className="grid gap-4">
                  <div>
                    <Label className="mb-2 block">価格許容誤差（±{tolPct}%）</Label>
                    <Slider value={[tolPct]} min={1} max={30} step={1} onValueChange={([v])=>setTolPct(v)} />
                  </div>
                  <div className="flex items-center justify-between p-3 rounded-xl border bg-white">
                    <div>
                      <div className="font-medium">名前の一致を厳格にする</div>
                      <div className="text-sm text-gray-500">オン：完全一致（エイリアス可） / オフ：部分一致OK</div>
                    </div>
                    <Switch checked={strictName} onCheckedChange={setStrictName}/>
                  </div>
                  <div className="grid gap-2">
                    <Label>PSA フィルタ</Label>
                    <Select value={psaFilter} onValueChange={setPsaFilter}>
                      <SelectTrigger className="w-48"><SelectValue/></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">すべて</SelectItem>
                        <SelectItem value="10">PSA10のみ</SelectItem>
                        <SelectItem value="9以下">PSA9以下</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="grid gap-4">
                  <div className="grid gap-2">
                    <Label>CSVインポート <span className="text-xs text-gray-500">（推奨ヘッダ：IMG_URL, NAME, PSA, PRICE, ACTIVE, ALIASES）</span></Label>
                    <label className="border-dashed border rounded-xl p-6 grid place-items-center bg-white cursor-pointer hover:bg-gray-50">
                      <Upload className="h-6 w-6 mb-1"/>
                      <div className="text-sm">ファイルを選択</div>
                      <input type="file" accept=".csv" className="hidden" onChange={e=>{ const f=e.target.files?.[0]; if(f) importCSV(f); e.currentTarget.value=""; }} />
                    </label>
                  </div>

                  <div className="grid gap-2">
                    <Label>JSONインポート（配列）</Label>
                    <textarea className="min-h-28 rounded-xl border p-3" placeholder='[
  {"IMG_URL":"https://...","NAME":"ピカチュウ","PSA":10,"PRICE":58000,"ALIASES":"ピカ, pikachu"}
]' onBlur={(e)=>{ const t=e.target.value.trim(); if(t) importJSON(t); }}/>
                  </div>

                  <div className="text-sm text-gray-500">
                    インポート後は <b>間違いが多いカードが出やすく</b> なります。暗記速度が上がります。
                  </div>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          {/* 履歴 */}
          <TabsContent value="history">
            <Card>
              <CardHeader>
                <CardTitle>回答履歴（{user}）</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto">
                  <table className="min-w-full text-sm">
                    <thead>
                      <tr className="bg-gray-100">
                        <th className="p-2 text-left">日時</th>
                        <th className="p-2 text-left">カード</th>
                        <th className="p-2 text-left">正解相場</th>
                        <th className="p-2 text-left">回答</th>
                        <th className="p-2 text-left">判定</th>
                      </tr>
                    </thead>
                    <tbody>
                      {results.filter(r=>r.user===user).map((r,i)=> (
                        <tr key={i} className="border-b">
                          <td className="p-2 whitespace-nowrap">{new Date(r.ts).toLocaleString()}</td>
                          <td className="p-2 whitespace-nowrap">{r.correctName}</td>
                          <td className="p-2 whitespace-nowrap">{r.correctPrice.toLocaleString()} 円</td>
                          <td className="p-2 whitespace-nowrap">{r.answeredName} / {r.answeredPrice.toLocaleString()} 円</td>
                          <td className="p-2 whitespace-nowrap">{r.correct?"✅ 正解":"❌"}（名:{r.nameOk?"○":"×"} 価:{r.priceOk?"○":"×"}）</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>

        <Card>
          <CardContent className="text-xs text-gray-500 p-4">
            <div className="mb-1">ヒント：</div>
            <ul className="list-disc ml-5 space-y-1">
              <li>Enter = 採点 / Ctrl+Enter = 次の問題</li>
              <li>価格はカンマ/円ありでもOK（自動で数値化）</li>
              <li>CSV は <b>IMG_URL, NAME, PSA, PRICE, ACTIVE, ALIASES</b> ヘッダ対応</li>
            </ul>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
