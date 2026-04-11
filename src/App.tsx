/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useCallback, useEffect } from 'react';
import { GoogleGenAI, GenerateContentResponse } from "@google/genai";
import { 
  Upload, 
  Search, 
  CheckCircle2, 
  AlertCircle, 
  HelpCircle, 
  Info, 
  ShieldCheck, 
  Camera, 
  X, 
  Loader2,
  FileText,
  UserCheck,
  MessageSquare,
  BarChart3,
  TrendingUp,
  Globe,
  ThumbsUp,
  ThumbsDown,
  AlertTriangle,
  ExternalLink,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  Twitter,
  Facebook
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

// --- Types ---

type AnalysisStep = 'parsing' | 'classification' | 'extraction' | 'research' | 'sourceCheck' | 'verdict';

interface StepInfo {
  id: AnalysisStep;
  label: string;
  description: string;
}

interface Claim {
  id: string;
  claim_text: string;
  verification_status: 'true' | 'false' | 'misleading' | 'unverified';
  confidence_score: number;
  explanation: string;
  sources: string[];
  times_requested: number;
  user_votes: { true: number; false: number; misleading: number };
  date_submitted: any;
  source_username: string;
}

interface GlobalStats {
  total_claims: number;
  total_verifications: number;
  avg_confidence: number;
  status_distribution: { true: number; false: number; misleading: number; unverified: number };
}

const ANALYSIS_STEPS: StepInfo[] = [
  { id: 'parsing', label: 'Parsing', description: 'Detecting format and extracting text' },
  { id: 'classification', label: 'Classification', description: 'Categorizing content type' },
  { id: 'extraction', label: 'Extraction', description: 'Identifying checkable claims' },
  { id: 'research', label: 'Research', description: 'Verifying claims via search' },
  { id: 'sourceCheck', label: 'Source Check', description: 'Analyzing account credibility' },
  { id: 'verdict', label: 'Final Verdict', description: 'Synthesizing all evidence' },
];

// --- Constants ---

const BASE_SYSTEM_PROMPT = `You are Fallaxis, an AI assistant that analyzes screenshots of Instagram content.
Your job is to act like a careful investigator.

CORE RULES:
1. Do not treat all content as a factual claim. Many screenshots are opinions, jokes, satire, slang, announcements, etc.
2. Be cautious and honest. If evidence is weak or context is missing, say so.
3. Assess ONLY public-facing credibility signals.
4. Explain slang/humor (e.g., "aura", "washed", "elite ball knowledge", "he knows ball", "generational") before fact-checking. These are often opinions or cultural commentary, not checkable facts.
5. Date matters. Consider if the claim is outdated.
6. Separate visible content from inference.
7. Avoid overconfident wording on cropped, blurry, or incomplete screenshots.`;

// --- Components ---

export default function App() {
  const [currentPage, setCurrentPage] = useState<'home' | 'how-it-works' | 'stats' | 'privacy'>('home');
  const [image, setImage] = useState<string | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [currentStep, setCurrentStep] = useState<AnalysisStep | null>(null);
  const [stepResults, setStepResults] = useState<Record<string, string>>({});
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [globalStats, setGlobalStats] = useState<GlobalStats | null>(null);
  const [trendingClaims, setTrendingClaims] = useState<Claim[]>([]);
  const [selectedClaim, setSelectedClaim] = useState<Claim | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const fetchStats = async () => {
    try {
      const [statsRes, trendingRes] = await Promise.all([
        fetch('/api/stats/global'),
        fetch('/api/claims/trending')
      ]);
      if (statsRes.ok) setGlobalStats(await statsRes.json());
      if (trendingRes.ok) setTrendingClaims(await trendingRes.json());
    } catch (err) {
      console.error("Failed to fetch stats:", err);
    }
  };

  useEffect(() => {
    fetchStats();
    const interval = setInterval(fetchStats, 30000); // Refresh every 30s
    return () => clearInterval(interval);
  }, []);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = () => {
        setImage(reader.result as string);
        setResult(null);
        setStepResults({});
        setCurrentStep(null);
        setError(null);
      };
      reader.readAsDataURL(file);
    }
  };

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (file && file.type.startsWith('image/')) {
      const reader = new FileReader();
      reader.onloadend = () => {
        setImage(reader.result as string);
        setResult(null);
        setStepResults({});
        setCurrentStep(null);
        setError(null);
      };
      reader.readAsDataURL(file);
    }
  }, []);

  const analyzeImage = async () => {
    if (!image) return;

    setIsAnalyzing(true);
    setError(null);
    setStepResults({});
    const base64Data = image.split(',')[1];
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
    const model = "gemini-3-flash-preview";

    try {
      // Step 1: Initial Analysis (Combining Parsing, Classification, Extraction)
      setCurrentStep('parsing');
      const initialAnalysisPrompt = `
You are an AI that classifies Instagram screenshot content BEFORE any fact-checking is done.
Your job is to determine what type of content this is, not whether it is true or false.

IMPORTANT RULES:
1. Do NOT assume everything is a factual claim.
2. Many posts are NOT fact-checkable.
3. Be careful with slang, memes, jokes, and opinions.
4. Only label something as a "factual claim" if it contains a clear, specific, verifiable statement.

CLASSIFICATION CATEGORIES:
- factual_claim (clear, checkable statement of fact)
- opinion (subjective view, "I think", "best ever")
- announcement (event, product launch, personal news)
- meme_joke (humor, sarcasm, not meant to be taken literally)
- satire_parody (intentional exaggeration for commentary)
- slang_cultural (heavy use of 'aura', 'washed', 'generational', etc.)
- promotional (marketing, ads, "buy now")
- unclear_mixed (multiple types or hard to tell)

STEP-BY-STEP TASK:
1. Identify the format (Instagram Story, feed post, reel, meme, reposted tweet, etc.).
2. Extract all visible text and visible account/source info.
3. Classify the content using the categories above.
4. Decide: is_fact_checkable? (True only if it contains a specific factual claim).
5. If fact-checkable: extract up to 3 short, specific claims.
6. If NOT fact-checkable: explain why (e.g., "This is a subjective opinion about a sports player").
7. Explain any slang used (e.g., 'aura', 'washed', 'elite ball knowledge', 'he knows ball', 'generational').

OUTPUT FORMAT (STRICT JSON):
{
  "format": "string",
  "visible_text": "string",
  "primary_category": "string",
  "secondary_category": "string",
  "is_fact_checkable": boolean,
  "claims": ["string", "string", "string"],
  "non_fact_checkable_reason": "string",
  "slang_explanations": { "term": "explanation" },
  "classification_confidence": "high/medium/low"
}
`;

      const initialResp = await ai.models.generateContent({
        model,
        contents: [{ parts: [
          { text: initialAnalysisPrompt },
          { inlineData: { data: base64Data, mimeType: "image/png" } }
        ]}],
        config: { 
          systemInstruction: BASE_SYSTEM_PROMPT,
          responseMimeType: "application/json"
        }
      });
      
      const initialData = JSON.parse(initialResp.text || "{}");
      setStepResults(prev => ({ 
        ...prev, 
        parsing: initialData.visible_text,
        classification: `${initialData.primary_category}${initialData.secondary_category ? ' / ' + initialData.secondary_category : ''}. Confidence: ${initialData.classification_confidence}`,
        extraction: initialData.is_fact_checkable ? initialData.claims.join('\n') : initialData.non_fact_checkable_reason,
        format: initialData.format,
        slang: initialData.slang_explanations
      }));

      // Step 2: Research (Only if fact-checkable)
      let researchText = "Not a fact-checkable claim.";
      let sourcesList = "";
      
      if (initialData.is_fact_checkable && initialData.claims.length > 0) {
        setCurrentStep('research');
        const researchResp = await ai.models.generateContent({
          model,
          contents: [{ parts: [
            { text: `STEP 2: Research. Research these claims: ${initialData.claims.join(', ')}. Use Google Search to verify. Check for corroboration, date sensitivity, outdated info, missing context, or exaggerated wording. Provide a detailed research result.` }
          ]}],
          config: { 
            systemInstruction: BASE_SYSTEM_PROMPT,
            tools: [{ googleSearch: {} }]
          }
        });
        researchText = researchResp.text || "";
        
        const groundingChunks = researchResp.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
        sourcesList = groundingChunks
          .filter(chunk => chunk.web)
          .map(chunk => `${chunk.web.title || 'Source'}: ${chunk.web.uri}`)
          .join('\n');
      }

      setStepResults(prev => ({ ...prev, research: researchText, sources: sourcesList }));

      // Step 3: Source Check
      setCurrentStep('sourceCheck');
      const sourceResp = await ai.models.generateContent({
        model,
        contents: [{ parts: [
          { text: `STEP 3: Source check. Analyze the visible account/source info: ${initialData.visible_text}. Classify as: official source, news/reporting account, commentary account, fan account, meme page, parody/satire, repost/aggregator, brand/business, or unclear. Assess credibility based ONLY on visible signals.` }
        ]}],
        config: { systemInstruction: BASE_SYSTEM_PROMPT }
      });
      const sourceText = sourceResp.text || "";
      setStepResults(prev => ({ ...prev, sourceCheck: sourceText }));

      // Step 4: Final Verdict
      setCurrentStep('verdict');
      const finalResp = await ai.models.generateContent({
        model,
        contents: [{ parts: [
          { text: `STEP 4: Final Verdict. Synthesize all previous steps to provide a final report in this EXACT format.
          
          CONTEXT FROM PREVIOUS STEPS:
          1. Initial Analysis: ${JSON.stringify(initialData)}
          2. Research: ${researchText}
          3. Source Check: ${sourceText}
          4. Research Sources:
          ${sourcesList || 'None found'}

          REPORT FORMAT:
          Content Type: [primary category]
          Format: [format]
          Visible Content: [visible text]
          Main Claim(s): [list claims as bulleted list, or 'None' if not fact-checkable]
          Source Check: [source check result]
          Research Result: [research result]
          Sources: [list as 'Title: URL']
          Verdict: [Choose from: likely true, likely false, misleading, missing context, outdated, opinion / not fact-checkable, satire / joke, announcement / not a factual claim, unclear / insufficient evidence]
          Why:
          - [reason 1]
          - [reason 2]
          Confidence:
          - Classification: [classification confidence]
          - Verdict: [high/medium/low]
          Extra Context: [slang explanations or context notes]` }
        ]}],
        config: { systemInstruction: BASE_SYSTEM_PROMPT }
      });
      
      setResult(finalResp.text || "No analysis generated.");

      // Step 5: Submit to Global Tracking
      if (initialData.is_fact_checkable && initialData.claims.length > 0) {
        try {
          // Parse final result for submission
          const lines = (finalResp.text || "").split('\n').map(l => l.trim());
          const getValue = (key: string) => {
            const line = lines.find(l => l.replace(/\*/g, '').toLowerCase().startsWith(key.toLowerCase() + ':'));
            return line ? line.split(':')[1]?.trim().replace(/\*/g, '') : '';
          };
          
          const verdict = getValue('Verdict');
          const confidenceLine = lines.find(l => l.replace(/\*/g, '').toLowerCase().includes('verdict:'));
          const confidence = confidenceLine ? parseInt(confidenceLine.split(':')[1]?.replace(/[^0-9]/g, '') || '0') : 0;
          
          const getList = (key: string) => {
            const startIndex = lines.findIndex(l => l.replace(/\*/g, '').toLowerCase().startsWith(key.toLowerCase() + ':'));
            if (startIndex === -1) return [];
            const list = [];
            for (let i = startIndex + 1; i < lines.length; i++) {
              const line = lines[i];
              if (line.startsWith('-') || line.startsWith('*')) list.push(line.substring(1).trim().replace(/\*/g, ''));
              else if (line !== '' && !line.startsWith('-') && !line.startsWith('*')) break;
            }
            return list;
          };

          await fetch('/api/claims/submit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              claim_text: initialData.claims.join('; '),
              source_username: initialData.visible_text.match(/Account:?\s*([^\n]+)/i)?.[1] || "unknown",
              image_hash: base64Data.substring(0, 100),
              verification_status: verdict.toLowerCase(),
              confidence_score: confidence,
              explanation: getList('Why').join(' '),
              sources: getList('Sources').map(s => s.split(':').slice(1).join(':').trim()).filter(Boolean)
            })
          });
          fetchStats();
        } catch (err) {
          console.error("Failed to submit claim:", err);
        }
      }
    } catch (err) {
      console.error(err);
      setError("Failed to analyze image. Please check your connection and try again.");
    } finally {
      setIsAnalyzing(false);
      setCurrentStep(null);
    }
  };

  const clearImage = () => {
    setImage(null);
    setResult(null);
    setStepResults({});
    setCurrentStep(null);
    setError(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  return (
    <div className="min-h-screen bg-background text-foreground font-sans selection:bg-accent/30 selection:text-accent relative overflow-x-hidden">
      {/* Atmospheric Background Elements */}
      <div className="noise-overlay" />
      <div className="fixed inset-0 pointer-events-none overflow-hidden">
        <div className="absolute top-[-10%] left-[-10%] w-[60%] h-[60%] rounded-full bg-accent/5 blur-[120px] animate-pulse" />
        <div className="absolute bottom-[-10%] right-[-10%] w-[50%] h-[50%] rounded-full bg-accent/3 blur-[150px]" />
      </div>

      {/* Header */}
      <header className="sticky top-0 z-50 glass-dark border-b border-white/5 px-6 h-20">
        <div className="max-w-6xl mx-auto h-full flex items-center justify-between">
          <div 
            className="flex items-center gap-3 cursor-pointer group"
            onClick={() => setCurrentPage('home')}
          >
            <div className="w-10 h-10 bg-accent rounded-xl flex items-center justify-center shadow-glow-sm group-hover:shadow-glow-md transition-all duration-300 relative">
              <ShieldCheck className="text-background w-6 h-6" strokeWidth={2.5} />
              <div className="absolute -top-1 -right-1 w-3 h-3 bg-green-500 rounded-full border-2 border-background animate-pulse" />
            </div>
            <div>
              <h1 className="text-xl font-display font-bold tracking-tight">
                Fallaxis
              </h1>
              <div className="flex items-center gap-2">
                <p className="text-[10px] uppercase tracking-[0.4em] text-muted-foreground font-black">AI Investigator</p>
                <span className="text-[8px] px-1.5 py-0.5 rounded bg-accent/10 text-accent font-black tracking-widest border border-accent/20">BETA</span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-6 sm:gap-12">
            <nav className="hidden sm:flex items-center gap-8 text-sm font-medium">
              {[
                { id: 'how-it-works', label: 'How it works' },
                { id: 'stats', label: 'Global Stats' }
              ].map((item) => (
                <span 
                  key={item.id}
                  onClick={() => setCurrentPage(item.id as any)}
                  className={`cursor-pointer transition-all duration-200 hover:text-accent ${
                    currentPage === item.id ? 'text-accent' : 'text-muted-foreground'
                  }`}
                >
                  {item.label}
                </span>
              ))}
            </nav>
            <div className="flex items-center gap-4">
              <button className="hidden sm:block px-5 py-2 rounded-full bg-white/5 border border-white/10 text-xs font-bold hover:bg-white/10 transition-all">
                Contact
              </button>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-24 md:py-32">
        <AnimatePresence mode="wait">
          {currentPage === 'home' ? (
            <motion.div
              key="home"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="flex flex-col items-center w-full space-y-32"
            >
              <div className="flex flex-col items-center text-center space-y-8 relative">
                <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-96 h-96 bg-accent/5 blur-[100px] -z-10" />
                <motion.div
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  className="px-4 py-1.5 rounded-full bg-accent/10 border border-accent/20 text-[10px] font-black uppercase tracking-[0.3em] text-accent mb-2"
                >
                  <div className="inline-block w-1.5 h-1.5 rounded-full bg-accent animate-pulse shadow-glow-sm mr-2" />
                  Powered by Gemini AI
                </motion.div>
                <motion.h2 
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="text-5xl md:text-8xl font-display font-bold tracking-tight leading-[1.05]"
                >
                  Investigate the <br />
                  <span className="accent-text-gradient bg-clip-text text-transparent bg-gradient-to-r from-accent via-accent/80 to-accent shadow-glow-sm">Unseen Truth.</span>
                </motion.h2>
                <motion.p 
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.1 }}
                  className="text-xl text-muted-foreground leading-relaxed max-w-2xl font-medium"
                >
                  Upload a screenshot of a post, story, or reel. Our AI investigator dissects claims, sources, and context to reveal the reality behind the post.
                </motion.p>
              </div>

              <div className="flex flex-col gap-24 items-center w-full">
                
                {/* Top Section: Upload & Preview */}
                <section className="w-full max-w-3xl space-y-12">
                  {!image ? (
                    <motion.div 
                      initial={{ opacity: 0, scale: 0.95 }}
                      animate={{ opacity: 1, scale: 1 }}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={onDrop}
                      onClick={() => fileInputRef.current?.click()}
                      className="group relative aspect-[4/3] w-full glass rounded-[40px] flex flex-col items-center justify-center gap-8 cursor-pointer hover:border-accent/30 hover:bg-white/5 transition-all duration-500 shadow-2xl border-dashed border-2"
                    >
                      <div className="w-24 h-24 bg-white/5 rounded-2xl flex items-center justify-center group-hover:scale-110 group-hover:bg-accent/10 transition-all duration-500 shadow-xl border border-white/10">
                        <Upload className="w-10 h-10 text-muted-foreground group-hover:text-accent transition-colors duration-500" strokeWidth={1.5} />
                      </div>
                      <div className="text-center space-y-3">
                        <p className="text-2xl font-display font-bold tracking-tight">Drop screenshot here</p>
                        <p className="text-sm text-muted-foreground font-bold uppercase tracking-widest">PNG, JPG up to 10MB</p>
                      </div>
                      <input 
                        type="file" 
                        ref={fileInputRef} 
                        onChange={handleFileChange} 
                        accept="image/*" 
                        className="hidden" 
                      />
                    </motion.div>
                  ) : (
                    <motion.div 
                      initial={{ opacity: 0, scale: 0.95 }}
                      animate={{ opacity: 1, scale: 1 }}
                      className="space-y-12"
                    >
                      <div className="relative aspect-[4/3] w-full rounded-[40px] overflow-hidden shadow-2xl glass p-4">
                        <div className="w-full h-full rounded-[28px] overflow-hidden bg-background-alt flex items-center justify-center border border-white/5">
                          <img 
                            src={image} 
                            alt="Preview" 
                            className="max-w-full max-h-full object-contain"
                          />
                        </div>
                        <button 
                          onClick={clearImage}
                          className="absolute top-10 right-10 w-14 h-14 glass-dark text-white rounded-full flex items-center justify-center hover:bg-accent hover:text-background transition-all duration-300 shadow-2xl border border-white/10"
                        >
                          <X className="w-7 h-7" />
                        </button>
                      </div>
                      
                      <button
                        onClick={analyzeImage}
                        disabled={isAnalyzing}
                        className="group relative w-full py-6 rounded-[24px] font-display font-bold text-2xl shadow-glow-md hover:shadow-glow-lg hover:brightness-110 active:scale-[0.98] transition-all duration-500 disabled:opacity-50 overflow-hidden bg-accent text-background"
                      >
                        <div className="relative flex items-center justify-center gap-4">
                          {isAnalyzing ? (
                            <>
                              <Loader2 className="w-7 h-7 animate-spin" />
                              Investigating...
                            </>
                          ) : (
                            <>
                              <Search className="w-7 h-7" strokeWidth={2.5} />
                              Start Investigation
                            </>
                          )}
                        </div>
                      </button>
                    </motion.div>
                  )}

                  {error && (
                    <motion.div 
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="p-6 glass border-red-200/50 dark:border-red-500/20 rounded-3xl flex items-start gap-5 text-red-600 dark:text-red-400 shadow-xl shadow-red-100/20"
                    >
                      <AlertCircle className="w-7 h-7 shrink-0" />
                      <p className="text-base font-bold leading-relaxed">{error}</p>
                    </motion.div>
                  )}
                </section>

                {/* Bottom Section: Results */}
                <section className="w-full max-w-3xl relative min-h-[400px]">
                  <AnimatePresence mode="wait">
                    {!result && !isAnalyzing ? (
                      <motion.div 
                        key="empty"
                        initial={{ opacity: 0, scale: 0.95 }}
                        animate={{ opacity: 1, scale: 1 }}
                        exit={{ opacity: 0, scale: 0.95 }}
                        className="h-full glass rounded-[40px] p-20 flex flex-col items-center justify-center text-center space-y-12 shadow-2xl relative overflow-hidden"
                      >
                        <div className="absolute inset-0 bg-gradient-to-b from-accent/5 to-transparent opacity-50" />
                        
                        <div className="relative">
                          <div className="w-32 h-32 bg-accent/5 rounded-full flex items-center justify-center shadow-glow-sm border border-accent/10 relative group">
                            <div className="absolute inset-0 bg-accent/5 rounded-full animate-ping opacity-20" />
                            <ShieldCheck className="w-14 h-14 text-accent/40 group-hover:text-accent/60 transition-colors duration-500" strokeWidth={1.5} />
                          </div>
                          <div className="absolute -top-2 -right-2 w-8 h-8 bg-background border border-accent/20 rounded-lg flex items-center justify-center shadow-lg">
                            <div className="w-2 h-2 rounded-full bg-accent animate-pulse" />
                          </div>
                        </div>

                        <div className="space-y-4 relative">
                          <h3 className="text-3xl font-display font-bold tracking-tight">System Standby</h3>
                          <p className="text-muted-foreground max-w-xs mx-auto leading-relaxed font-bold uppercase tracking-[0.2em] text-[10px] opacity-80">
                            Upload a screenshot to initiate the <span className="text-accent">Fallaxis</span> investigative protocol.
                          </p>
                        </div>

                        <div className="flex gap-3 relative">
                          {[1, 2, 3].map(i => (
                            <div key={i} className="w-12 h-1 bg-white/5 rounded-full overflow-hidden">
                              <motion.div 
                                className="h-full bg-accent/20"
                                animate={{ 
                                  x: ['-100%', '100%'] 
                                }}
                                transition={{ 
                                  duration: 2, 
                                  repeat: Infinity, 
                                  delay: i * 0.4,
                                  ease: "linear"
                                }}
                              />
                            </div>
                          ))}
                        </div>
                      </motion.div>
                    ) : isAnalyzing ? (
                      <motion.div 
                        key="loading"
                        initial={{ opacity: 0, scale: 0.95 }}
                        animate={{ opacity: 1, scale: 1 }}
                        exit={{ opacity: 0, scale: 0.95 }}
                        className="h-full glass rounded-[40px] p-20 flex flex-col items-center justify-center shadow-2xl relative overflow-hidden"
                      >
                        <div className="absolute inset-0 bg-gradient-to-b from-accent/5 to-transparent opacity-50" />
                        
                        <div className="w-full max-w-xs space-y-16 relative">
                          <div className="relative flex justify-center">
                            <div className="w-32 h-32 border-[4px] border-white/5 border-t-accent rounded-full animate-spin shadow-glow-sm" />
                            <div className="absolute inset-0 m-auto w-24 h-24 border border-accent/10 rounded-full animate-pulse opacity-20" />
                            <Search className="absolute inset-0 m-auto w-10 h-10 text-accent animate-pulse" strokeWidth={2.5} />
                          </div>
                          
                          <div className="space-y-10">
                            <div className="text-center space-y-2">
                              <h3 className="text-3xl font-display font-bold tracking-tight">Analyzing Post</h3>
                              <p className="text-[10px] font-black uppercase tracking-[0.4em] text-accent animate-pulse">Processing Protocol</p>
                            </div>
                            
                            <div className="space-y-5">
                              {ANALYSIS_STEPS.map((step) => {
                                const isCompleted = !!stepResults[step.id];
                                const isActive = currentStep === step.id;
                                
                                return (
                                  <div key={step.id} className="flex items-center gap-5 group">
                                    <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 transition-all duration-500 border ${
                                      isCompleted ? 'bg-green-500/10 border-green-500/20 text-green-400' : 
                                      isActive ? 'bg-accent/10 border-accent/20 text-accent animate-pulse scale-110 shadow-glow-sm' : 
                                      'bg-white/5 border-white/10 text-muted-foreground opacity-40'
                                    }`}>
                                      {isCompleted ? <CheckCircle2 className="w-4 h-4" strokeWidth={3} /> : <div className="w-1.5 h-1.5 rounded-full bg-current" />}
                                    </div>
                                    <div className="flex-1">
                                      <p className={`text-[10px] font-black uppercase tracking-[0.2em] transition-colors duration-500 ${
                                        isActive ? 'text-accent' : isCompleted ? 'text-green-400' : 'text-muted-foreground opacity-40'
                                      }`}>
                                        {step.label}
                                      </p>
                                      {isActive && (
                                        <motion.div 
                                          initial={{ width: 0 }}
                                          animate={{ width: '100%' }}
                                          className="h-0.5 bg-accent/30 rounded-full mt-1.5"
                                        />
                                      )}
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        </div>
                      </motion.div>
                    ) : (
                      <motion.div 
                        key="result"
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        className="space-y-12"
                      >
                        <AnalysisDisplay markdown={result!} />
                        <button 
                          onClick={clearImage}
                          className="w-full py-6 rounded-2xl bg-white/5 border border-white/10 text-muted-foreground font-display font-bold uppercase tracking-[0.3em] text-sm hover:bg-white/10 hover:text-foreground transition-all duration-300 shadow-xl"
                        >
                          Start New Analysis
                        </button>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </section>
              </div>
            </motion.div>
          ) : currentPage === 'how-it-works' ? (
            <HowItWorks key="how-it-works" />
          ) : currentPage === 'stats' ? (
            <StatsPage 
              key="stats" 
              globalStats={globalStats} 
              trendingClaims={trendingClaims} 
              onSelectClaim={setSelectedClaim}
              onRefresh={fetchStats}
            />
          ) : (
            <PrivacyPolicy key="privacy" />
          )}
        </AnimatePresence>
      </main>

      <AnimatePresence>
        {selectedClaim && (
          <ClaimDetailModal 
            claim={selectedClaim} 
            onClose={() => setSelectedClaim(null)}
            onVote={async (vote) => {
              await fetch(`/api/claims/${selectedClaim.id}/vote`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ vote })
              });
              fetchStats();
              setSelectedClaim(prev => prev ? { ...prev, user_votes: { ...prev.user_votes, [vote]: prev.user_votes[vote as keyof typeof prev.user_votes] + 1 } } : null);
            }}
          />
        )}
      </AnimatePresence>

      {/* Footer */}
      <footer className="max-w-6xl mx-auto px-6 py-24 border-t border-white/5 mt-32">
        <div className="flex flex-col items-center gap-12 text-center">
          <div 
            className="flex items-center gap-4 opacity-40 grayscale hover:grayscale-0 transition-all duration-500 cursor-pointer group"
            onClick={() => setCurrentPage('home')}
          >
            <div className="w-10 h-10 bg-accent rounded-xl flex items-center justify-center group-hover:shadow-glow-sm transition-all">
              <ShieldCheck className="text-background w-6 h-6" strokeWidth={2.5} />
            </div>
            <span className="font-display font-bold tracking-tight text-2xl">Fallaxis</span>
          </div>
          
          <div className="flex items-center gap-10">
            <button onClick={() => setCurrentPage('how-it-works')} className="text-[10px] font-black uppercase tracking-widest text-muted-foreground hover:text-accent transition-colors">How it Works</button>
            <button onClick={() => setCurrentPage('privacy')} className="text-[10px] font-black uppercase tracking-widest text-muted-foreground hover:text-accent transition-colors">Privacy Policy</button>
            <a href="mailto:support@fallaxis.ai" className="text-[10px] font-black uppercase tracking-widest text-muted-foreground hover:text-accent transition-colors">Contact</a>
          </div>

          <p className="text-sm text-muted-foreground max-w-md leading-relaxed font-bold uppercase tracking-widest opacity-60">
            Fallaxis is an AI tool for educational purposes. Always verify critical information from multiple primary sources.
          </p>
        </div>
      </footer>
    </div>
  );
}

function ShareButtons({ text, url }: { text: string, url: string }) {
  const shareTwitter = () => {
    const twitterUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`;
    window.open(twitterUrl, '_blank');
  };

  const shareFacebook = () => {
    const facebookUrl = `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}`;
    window.open(facebookUrl, '_blank');
  };

  return (
    <div className="flex items-center gap-4">
      <button 
        onClick={shareTwitter}
        className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-white/5 border border-white/10 text-muted-foreground hover:bg-white/10 hover:text-foreground transition-all font-bold text-[10px] uppercase tracking-widest"
      >
        <Twitter className="w-4 h-4" /> Twitter
      </button>
      <button 
        onClick={shareFacebook}
        className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-white/5 border border-white/10 text-muted-foreground hover:bg-white/10 hover:text-foreground transition-all font-bold text-[10px] uppercase tracking-widest"
      >
        <Facebook className="w-4 h-4" /> Facebook
      </button>
    </div>
  );
}

function StatsPage({ globalStats, trendingClaims, onSelectClaim, onRefresh }: { 
  globalStats: GlobalStats | null, 
  trendingClaims: Claim[], 
  onSelectClaim: (c: Claim) => void,
  onRefresh: () => void | Promise<void>,
  key?: string
}) {
  return (
    <motion.div 
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -20 }}
      className="w-full max-w-6xl space-y-24"
    >
      <div className="flex flex-col items-center text-center space-y-8">
        <div className="w-20 h-20 bg-accent rounded-[24px] flex items-center justify-center shadow-glow-md">
          <Globe className="text-background w-10 h-10" strokeWidth={2.5} />
        </div>
        <h2 className="text-5xl md:text-8xl font-display font-bold tracking-tight">Global Stats</h2>
        <p className="text-muted-foreground font-bold uppercase tracking-[0.3em] text-xs">Real-time platform analytics</p>
      </div>

      {globalStats && <GlobalStatsDisplay stats={globalStats} />}

      <div className="space-y-12">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <TrendingUp className="text-accent w-8 h-8" />
            <h3 className="text-3xl font-display font-bold tracking-tight">Trending Claims</h3>
          </div>
          <button 
            onClick={onRefresh}
            className="text-xs font-black uppercase tracking-widest text-muted-foreground hover:text-accent transition-colors"
          >
            Refresh
          </button>
        </div>

        <TrendingClaimsList claims={trendingClaims} onSelect={onSelectClaim} />
      </div>
    </motion.div>
  );
}

function HowItWorks() {
  const steps = [
    {
      title: "Image Parsing",
      description: "Our AI scans the screenshot to detect the post format (Story, Reel, Post) and extracts all visible text using advanced OCR.",
      icon: Camera
    },
    {
      title: "Content Classification",
      description: "We determine if the content is a checkable factual claim, an opinion, a joke, or cultural commentary (like 'aura' or 'washed').",
      icon: BarChart3
    },
    {
      title: "Claim Extraction",
      description: "Specific, verifiable statements are identified and isolated for deep research.",
      icon: MessageSquare
    },
    {
      title: "Real-time Research",
      description: "The engine performs live web searches to find primary sources, official data, and expert consensus.",
      icon: Search
    },
    {
      title: "Source Verification",
      description: "We analyze the credibility of the account sharing the information based on public-facing signals.",
      icon: UserCheck
    },
    {
      title: "Final Verdict",
      description: "All gathered evidence is synthesized into a clear verdict: True, False, or Misleading, with a detailed explanation.",
      icon: ShieldCheck
    }
  ];

  return (
    <motion.div 
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -20 }}
      className="w-full max-w-5xl space-y-24"
    >
      <div className="text-center space-y-8">
        <h2 className="text-5xl md:text-8xl font-display font-bold tracking-tight">How it Works</h2>
        <p className="text-muted-foreground font-bold uppercase tracking-[0.3em] text-xs">The science behind the verification</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
        {steps.map((step, i) => (
          <div key={i} className="glass p-12 rounded-[40px] space-y-8 hover:scale-[1.02] transition-all duration-500 group relative overflow-hidden">
            <div className="absolute -top-4 -right-4 text-9xl font-display font-black text-white/5 select-none group-hover:text-accent/5 transition-colors duration-500">
              {i + 1}
            </div>
            <div className="w-16 h-16 bg-accent rounded-2xl flex items-center justify-center shadow-glow-sm group-hover:shadow-glow-md transition-all duration-300 relative z-10">
              <step.icon className="text-background w-8 h-8" strokeWidth={2} />
            </div>
            <div className="space-y-4 relative z-10">
              <h3 className="text-2xl font-display font-bold tracking-tight group-hover:text-accent transition-colors">{step.title}</h3>
              <p className="text-lg text-muted-foreground leading-relaxed font-medium">{step.description}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="pt-12 flex justify-center">
        <button 
          onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
          className="px-12 py-5 rounded-2xl bg-white/5 border border-white/10 text-muted-foreground font-display font-bold uppercase tracking-widest text-xs hover:bg-white/10 hover:text-foreground transition-all"
        >
          Back to Top
        </button>
      </div>
    </motion.div>
  );
}

function PrivacyPolicy() {
  return (
    <motion.div 
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -20 }}
      className="w-full max-w-4xl glass p-16 rounded-[48px] space-y-16"
    >
      <div className="space-y-6">
        <h2 className="text-5xl font-display font-bold tracking-tight">Privacy Policy</h2>
        <p className="text-muted-foreground font-bold uppercase tracking-[0.3em] text-xs">Last updated: April 2026</p>
      </div>

      <div className="space-y-12 text-muted-foreground font-medium leading-relaxed">
        <section className="space-y-6 group">
          <div className="flex items-center gap-4">
            <div className="w-1 h-8 bg-accent/30 rounded-full group-hover:bg-accent transition-colors" />
            <h3 className="text-2xl font-display font-bold text-foreground tracking-tight">1. Data Collection</h3>
          </div>
          <p className="text-lg pl-5">
            Fallaxis processes the screenshots you upload solely for the purpose of fact-checking. We do not store original images permanently. Once the analysis is complete, the image is discarded from our temporary processing cache.
          </p>
        </section>

        <section className="space-y-6 group">
          <div className="flex items-center gap-4">
            <div className="w-1 h-8 bg-accent/30 rounded-full group-hover:bg-accent transition-colors" />
            <h3 className="text-2xl font-display font-bold text-foreground tracking-tight">2. AI Processing</h3>
          </div>
          <p className="text-lg pl-5">
            We use Google Gemini models to analyze text and images. Your data is processed securely and is not used to train global AI models without your explicit consent.
          </p>
        </section>

        <section className="space-y-6 group">
          <div className="flex items-center gap-4">
            <div className="w-1 h-8 bg-accent/30 rounded-full group-hover:bg-accent transition-colors" />
            <h3 className="text-2xl font-display font-bold text-foreground tracking-tight">3. Public Claims</h3>
          </div>
          <p className="text-lg pl-5">
            Extracted factual claims (text only) may be stored in our global database to provide trending statistics and prevent redundant analysis. No personal information from the screenshot (like your own profile picture or DMs) is stored.
          </p>
        </section>

        <section className="space-y-6 group">
          <div className="flex items-center gap-4">
            <div className="w-1 h-8 bg-accent/30 rounded-full group-hover:bg-accent transition-colors" />
            <h3 className="text-2xl font-display font-bold text-foreground tracking-tight">4. Cookies</h3>
          </div>
          <p className="text-lg pl-5">
            We use local storage only to remember your preferences. No tracking cookies or third-party advertising scripts are used.
          </p>
        </section>

        <div className="pt-12 border-t border-white/5 flex flex-col sm:flex-row items-center justify-between gap-8">
          <p className="text-xs font-bold uppercase tracking-[0.2em] text-muted-foreground">
            Questions? Contact us at privacy@instafact.ai
          </p>
          <button 
            onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
            className="px-8 py-4 rounded-xl bg-white/5 border border-white/10 text-muted-foreground font-display font-bold uppercase tracking-widest text-[10px] hover:bg-white/10 hover:text-foreground transition-all"
          >
            Back to Top
          </button>
        </div>
      </div>
    </motion.div>
  );
}

function GlobalStatsDisplay({ stats }: { stats: GlobalStats }) {
  const items = [
    { label: 'Total Claims', value: stats.total_claims.toLocaleString(), icon: FileText, color: 'text-accent' },
    { label: 'Verifications', value: stats.total_verifications.toLocaleString(), icon: ShieldCheck, color: 'text-green-400' },
    { label: 'Avg Confidence', value: `${Math.round(stats.avg_confidence)}%`, icon: BarChart3, color: 'text-accent' },
    { label: 'Global Reach', value: '1.2M+', icon: Globe, color: 'text-purple-400' },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-8">
      {items.map((item, i) => (
        <motion.div 
          key={i}
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: i * 0.1 }}
          className="glass p-10 rounded-[40px] flex flex-col items-center text-center space-y-6 hover:scale-105 transition-all duration-500 group relative overflow-hidden"
        >
          <div className="absolute inset-0 bg-gradient-to-b from-accent/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500" />
          <div className={`w-14 h-14 rounded-2xl bg-white/5 flex items-center justify-center border border-white/10 group-hover:bg-accent/10 group-hover:border-accent/30 transition-all duration-300 relative z-10 ${item.color}`}>
            <item.icon className="w-7 h-7" />
          </div>
          <div className="relative z-10">
            <p className="text-4xl font-display font-bold tracking-tight group-hover:text-accent transition-colors">{item.value}</p>
            <p className="text-[10px] font-black uppercase tracking-[0.3em] text-muted-foreground mt-2">{item.label}</p>
          </div>
        </motion.div>
      ))}
    </div>
  );
}

function TrendingClaimsList({ claims, onSelect }: { claims: Claim[], onSelect: (c: Claim) => void }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
      {claims.map((claim, i) => (
        <motion.div 
          key={claim.id}
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ delay: i * 0.05 }}
          onClick={() => onSelect(claim)}
          className="group glass p-10 rounded-[40px] cursor-pointer hover:bg-white/[0.08] hover:border-accent/30 transition-all duration-500 flex flex-col justify-between min-h-[280px] relative overflow-hidden"
        >
          <div className="absolute top-0 right-0 w-32 h-32 bg-accent/5 blur-3xl -z-10 group-hover:bg-accent/10 transition-colors" />
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
                <span className={`px-4 py-1.5 rounded-full text-[9px] font-black uppercase tracking-widest ${
                  claim.verification_status === 'true' ? 'bg-green-500/10 text-green-400 border border-green-500/20' :
                  claim.verification_status === 'false' ? 'bg-red-500/10 text-red-400 border border-red-500/20' :
                  'bg-accent/10 text-accent border border-accent/20'
                }`}>
                  {claim.verification_status}
                </span>
              </div>
              <div className="flex items-center gap-2 text-muted-foreground">
                <UserCheck className="w-4 h-4" />
                <span className="text-[10px] font-black uppercase tracking-widest">{claim.times_requested} requests</span>
              </div>
            </div>
            <p className="text-xl font-display font-bold text-foreground/90 line-clamp-3 leading-relaxed group-hover:text-foreground transition-colors">
              "{claim.claim_text}"
            </p>
          </div>
          <div className="pt-8 flex items-center justify-between border-t border-white/5 mt-6">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-full bg-accent flex items-center justify-center text-[10px] text-background font-black shadow-glow-sm">
                {claim.source_username[0].toUpperCase()}
              </div>
              <span className="text-xs font-bold text-muted-foreground group-hover:text-foreground transition-colors">@{claim.source_username}</span>
            </div>
            <ChevronRight className="w-5 h-5 text-muted-foreground group-hover:text-accent group-hover:translate-x-1 transition-all" />
          </div>
        </motion.div>
      ))}
    </div>
  );
}

function ClaimDetailModal({ claim, onClose, onVote }: { claim: Claim, onClose: () => void, onVote: (v: string) => void }) {
  const getHeaderColor = () => {
    const lower = claim.verification_status.toLowerCase();
    if (lower === 'true') return 'bg-green-500/10 text-green-400 border-green-500/20';
    if (lower === 'false') return 'bg-red-500/10 text-red-400 border-red-500/20';
    return 'bg-accent/10 text-accent border-accent/20';
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-6">
      <motion.div 
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={onClose}
        className="absolute inset-0 bg-background/80 backdrop-blur-xl"
      />
      <motion.div 
        initial={{ opacity: 0, scale: 0.9, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.9, y: 20 }}
        className="relative w-full max-w-2xl glass-dark rounded-[48px] overflow-hidden shadow-2xl border border-white/10"
      >
        <div className={`p-12 flex items-center justify-between border-b ${getHeaderColor()}`}>
          <div className="space-y-2">
            <p className="text-[11px] uppercase tracking-[0.4em] font-black opacity-60">Verified Claim</p>
            <h3 className="text-4xl font-display font-bold uppercase tracking-tight leading-none">{claim.verification_status}</h3>
          </div>
          <button onClick={onClose} className="w-14 h-14 rounded-full bg-white/5 flex items-center justify-center text-foreground hover:bg-white/10 transition-all border border-white/10">
            <X className="w-7 h-7" />
          </button>
        </div>

        <div className="p-12 space-y-12">
          <div className="space-y-6">
            <div className="flex items-center gap-3 text-muted-foreground">
              <MessageSquare className="w-5 h-5" />
              <h4 className="text-[11px] uppercase font-black tracking-[0.3em]">Claim Text</h4>
            </div>
            <p className="text-3xl font-display font-bold text-foreground leading-tight italic">"{claim.claim_text}"</p>
          </div>

          <div className="space-y-6">
            <div className="flex items-center gap-3 text-muted-foreground">
              <Info className="w-5 h-5" />
              <h4 className="text-[11px] uppercase font-black tracking-[0.3em]">Explanation</h4>
            </div>
            <p className="text-xl text-muted-foreground leading-relaxed font-medium">{claim.explanation}</p>
          </div>

          {claim.sources.length > 0 && (
            <div className="space-y-6">
              <div className="flex items-center gap-3 text-muted-foreground">
                <ExternalLink className="w-5 h-5" />
                <h4 className="text-[11px] uppercase font-black tracking-[0.3em]">Sources</h4>
              </div>
              <div className="flex flex-wrap gap-3">
                {claim.sources.map((url, i) => (
                  <a key={i} href={url} target="_blank" rel="noopener noreferrer" className="px-5 py-3 rounded-xl bg-white/5 border border-white/10 text-xs font-bold text-accent hover:bg-accent hover:text-background transition-all flex items-center gap-2 group">
                    Source {i + 1} <ExternalLink className="w-3.5 h-3.5 group-hover:scale-110 transition-transform" />
                  </a>
                ))}
              </div>
            </div>
          )}

          <div className="pt-12 border-t border-white/5 space-y-8">
            <div className="flex items-center justify-between">
              <h4 className="text-[11px] uppercase font-black tracking-[0.3em] text-muted-foreground">Community Verification</h4>
              <ShareButtons 
                text={`Fallaxis Verification: ${claim.verification_status.toUpperCase()} - ${claim.claim_text}`}
                url={window.location.href}
              />
            </div>
            <div className="grid grid-cols-3 gap-6">
              <button 
                onClick={() => onVote('true')}
                className="flex flex-col items-center gap-4 p-8 rounded-[32px] bg-green-500/5 border border-green-500/10 hover:bg-green-500/10 transition-all group"
              >
                <ThumbsUp className="w-8 h-8 text-green-500 group-hover:scale-110 transition-transform" />
                <span className="text-xs font-black text-green-500">{claim.user_votes.true}</span>
              </button>
              <button 
                onClick={() => onVote('false')}
                className="flex flex-col items-center gap-4 p-8 rounded-[32px] bg-red-500/5 border border-red-500/10 hover:bg-red-500/10 transition-all group"
              >
                <ThumbsDown className="w-8 h-8 text-red-500 group-hover:scale-110 transition-transform" />
                <span className="text-xs font-black text-red-500">{claim.user_votes.false}</span>
              </button>
              <button 
                onClick={() => onVote('misleading')}
                className="flex flex-col items-center gap-4 p-8 rounded-[32px] bg-accent/5 border border-accent/10 hover:bg-accent/10 transition-all group"
              >
                <AlertTriangle className="w-8 h-8 text-accent group-hover:scale-110 transition-transform" />
                <span className="text-xs font-black text-accent">{claim.user_votes.misleading}</span>
              </button>
            </div>
          </div>
        </div>
      </motion.div>
    </div>
  );
}

function AnalysisDisplay({ markdown }: { markdown: string }) {
  const [isVisibleContentCollapsed, setIsVisibleContentCollapsed] = useState(false);
  const [isSourceCheckCollapsed, setIsSourceCheckCollapsed] = useState(false);
  const [isResearchResultCollapsed, setIsResearchResultCollapsed] = useState(false);
  const [isWhyCollapsed, setIsWhyCollapsed] = useState(false);
  
  const formatValue = (val: string) => {
    if (!val) return '';
    return val
      .split('_')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(' ');
  };

  const lines = markdown.split('\n').map(l => l.trim());
  
  const getValue = (key: string) => {
    const line = lines.find(l => {
      const cleanLine = l.replace(/\*/g, '').trim();
      return cleanLine.toLowerCase().startsWith(key.toLowerCase() + ':');
    });
    if (!line) return '';
    const colonIndex = line.indexOf(':');
    return line.substring(colonIndex + 1).trim().replace(/\*/g, '');
  };

  const getList = (key: string) => {
    const startIndex = lines.findIndex(l => {
      const cleanLine = l.replace(/\*/g, '').trim();
      return cleanLine.toLowerCase().startsWith(key.toLowerCase() + ':');
    });
    if (startIndex === -1) return [];
    
    const list = [];
    const firstLine = lines[startIndex];
    const colonIndex = firstLine.indexOf(':');
    const sameLineContent = firstLine.substring(colonIndex + 1).trim().replace(/\*/g, '');
    if (sameLineContent && !sameLineContent.startsWith('-') && !sameLineContent.startsWith('*')) {
      list.push(sameLineContent);
    } else if (sameLineContent && (sameLineContent.startsWith('-') || sameLineContent.startsWith('*'))) {
      list.push(sameLineContent.substring(1).trim());
    }

    for (let i = startIndex + 1; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith('-') || line.startsWith('*')) {
        list.push(line.substring(1).trim().replace(/\*/g, ''));
      } else if (line === '' || (line.includes(':') && !line.startsWith('-') && !line.startsWith('*'))) {
        if (line !== '') break;
      }
    }
    return list;
  };

  const getParagraph = (key: string) => {
    const startIndex = lines.findIndex(l => {
      const cleanLine = l.replace(/\*/g, '').trim();
      return cleanLine.toLowerCase().startsWith(key.toLowerCase() + ':');
    });
    if (startIndex === -1) return '';
    
    const firstLine = lines[startIndex];
    const colonIndex = firstLine.indexOf(':');
    let content = firstLine.substring(colonIndex + 1).trim().replace(/\*/g, '');
    
    for (let i = startIndex + 1; i < lines.length; i++) {
      const line = lines[i];
      if (line === '') {
        content += '\n';
        continue;
      }
      const cleanLine = line.replace(/\*/g, '').trim();
      if (cleanLine.includes(':') && !line.startsWith('-') && !line.startsWith('*')) break;
      content += (content.endsWith('\n') ? '' : ' ') + line.replace(/\*/g, '');
    }
    return content.trim();
  };

  const contentType = getValue('Content Type');
  const format = getValue('Format');
  const visibleContent = getParagraph('Visible Content');
  const mainClaims = getList('Main Claim(s)').filter(c => {
    const lower = c.toLowerCase();
    return !lower.includes('no clear checkable factual claim') && 
           !lower.includes('no checkable claims identified') &&
           !lower.includes('none found') &&
           !lower.includes('n/a') &&
           !lower.includes('none');
  });
  const sourceCheck = getParagraph('Source Check');
  const researchResult = getParagraph('Research Result');
  const sources = getList('Sources');
  const verdict = getValue('Verdict');
  const extraContext = getValue('Extra Context');
  
  const classificationConfidence = lines.find(l => l.replace(/\*/g, '').toLowerCase().includes('classification:'))?.split(':')[1]?.trim().replace(/\*/g, '') || 'low';
  const verdictConfidence = lines.find(l => l.replace(/\*/g, '').toLowerCase().includes('verdict:'))?.split(':')[1]?.trim().replace(/\*/g, '') || 'low';

  const getVerdictStyles = (v: string) => {
    const lower = v.toLowerCase();
    if (lower.includes('true')) return 'bg-green-500/10 text-green-400 border border-green-500/20 shadow-[0_0_30px_rgba(34,197,94,0.1)]';
    if (lower.includes('false')) return 'bg-red-500/10 text-red-400 border border-red-500/20 shadow-[0_0_30px_rgba(239,68,68,0.1)]';
    if (lower.includes('misleading') || lower.includes('context')) return 'bg-accent/10 text-accent border border-accent/20 shadow-[0_0_30px_rgba(245,158,11,0.1)]';
    if (lower.includes('satire') || lower.includes('joke')) return 'bg-purple-500/10 text-purple-400 border border-purple-500/20 shadow-[0_0_30px_rgba(168,85,247,0.1)]';
    return 'bg-white/5 text-muted-foreground border border-white/10';
  };

  const getConfidenceColor = (c: string) => {
    const lower = c.toLowerCase();
    if (lower.includes('high')) return 'text-green-400 bg-green-500/10 border-green-500/20';
    if (lower.includes('medium')) return 'text-accent bg-accent/10 border-accent/20';
    return 'text-red-400 bg-red-500/10 border-red-500/20';
  };

  return (
    <div className="space-y-8 relative">
      <div className="absolute -left-10 top-0 bottom-0 w-px bg-gradient-to-b from-transparent via-accent/20 to-transparent hidden xl:block" />
      
      {/* 1. Verdict Banner */}
      <motion.div 
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        className={`rounded-[32px] overflow-hidden ${getVerdictStyles(verdict)}`}
      >
        <div className="px-10 py-10 flex items-center justify-between">
          <div className="space-y-2">
            <p className="text-[10px] uppercase tracking-[0.4em] font-black opacity-60">Investigation Verdict</p>
            <h3 className="text-4xl font-display font-bold tracking-tight leading-none">{verdict || 'Unclear'}</h3>
          </div>
          <div className="w-20 h-20 bg-white/5 rounded-full flex items-center justify-center backdrop-blur-xl border border-white/10">
            {verdict.toLowerCase().includes('true') ? <CheckCircle2 className="w-10 h-10" /> : 
             verdict.toLowerCase().includes('false') ? <AlertTriangle className="w-10 h-10" /> :
             <Info className="w-10 h-10" />}
          </div>
        </div>
      </motion.div>

      {/* 2. Format & Content Type Card */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
        <motion.div 
          initial={{ opacity: 0, x: -20 }}
          animate={{ opacity: 1, x: 0 }}
          className="glass p-8 rounded-[32px] space-y-4 hover:border-accent/30 transition-all duration-500 group"
        >
          <div className="flex items-center gap-3 text-muted-foreground group-hover:text-accent transition-colors">
            <Camera className="w-4 h-4" />
            <span className="text-[10px] uppercase font-black tracking-widest">Format</span>
          </div>
          <p className="text-xl font-display font-bold">{format}</p>
        </motion.div>
        <motion.div 
          initial={{ opacity: 0, x: 20 }}
          animate={{ opacity: 1, x: 0 }}
          className="glass p-8 rounded-[32px] space-y-4 hover:border-accent/30 transition-all duration-500 group"
        >
          <div className="flex items-center gap-3 text-muted-foreground group-hover:text-accent transition-colors">
            <BarChart3 className="w-4 h-4" />
            <span className="text-[10px] uppercase font-black tracking-widest">Content Type</span>
          </div>
          <p className="text-xl font-display font-bold">{formatValue(contentType)}</p>
        </motion.div>
      </div>

      {/* 3. Visible Content Card */}
      <motion.div 
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="glass p-10 rounded-[40px] space-y-6 hover:border-accent/20 transition-all duration-500"
      >
        <button 
          onClick={() => setIsVisibleContentCollapsed(!isVisibleContentCollapsed)}
          className="flex items-center justify-between w-full group"
        >
          <div className="flex items-center gap-3 text-muted-foreground">
            <Search className="w-4 h-4" />
            <h4 className="text-[10px] uppercase font-black tracking-[0.3em]">Visible Content</h4>
          </div>
          <div className="w-8 h-8 rounded-full bg-white/5 flex items-center justify-center text-muted-foreground group-hover:text-accent transition-all">
            {isVisibleContentCollapsed ? <ChevronDown className="w-4 h-4" /> : <ChevronUp className="w-4 h-4" />}
          </div>
        </button>
        <AnimatePresence initial={false}>
          {!isVisibleContentCollapsed && (
            <motion.div 
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="overflow-hidden"
            >
              <div className="relative pl-8 py-2">
                <p className="text-2xl text-foreground/90 leading-relaxed font-medium italic">
                  "{visibleContent}"
                </p>
                <div className="absolute top-0 left-0 w-1 h-full bg-accent/30 rounded-full" />
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>

      {/* 4. Main Claims Card */}
      <motion.div 
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="glass p-10 rounded-[40px] space-y-8 hover:border-accent/20 transition-all duration-500"
      >
        <div className="flex items-center gap-3 text-muted-foreground">
          <MessageSquare className="w-4 h-4" />
          <h4 className="text-[10px] uppercase font-black tracking-[0.3em]">Main Claims</h4>
        </div>
        <div className="space-y-4">
          {mainClaims.map((claim, i) => (
            <div 
              key={i} 
              className="p-6 bg-white/5 rounded-2xl border border-white/5 text-foreground/90 font-medium flex items-center gap-5 hover:bg-white/[0.08] transition-colors"
            >
              <div className="w-2 h-2 rounded-full bg-accent shrink-0 shadow-glow-sm" />
              <span className="text-lg">{claim}</span>
            </div>
          ))}
          {mainClaims.length === 0 && <p className="text-muted-foreground italic font-medium">No checkable claims identified.</p>}
        </div>
      </motion.div>

      {/* 5. Source Check Card */}
      <motion.div 
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="glass p-10 rounded-[40px] space-y-6 hover:border-accent/20 transition-all duration-500"
      >
        <button 
          onClick={() => setIsSourceCheckCollapsed(!isSourceCheckCollapsed)}
          className="flex items-center justify-between w-full group"
        >
          <div className="flex items-center gap-3 text-muted-foreground">
            <UserCheck className="w-4 h-4" />
            <h4 className="text-[10px] uppercase font-black tracking-[0.3em]">Source Check</h4>
          </div>
          <div className="w-8 h-8 rounded-full bg-white/5 flex items-center justify-center text-muted-foreground group-hover:text-accent transition-all">
            {isSourceCheckCollapsed ? <ChevronDown className="w-4 h-4" /> : <ChevronUp className="w-4 h-4" />}
          </div>
        </button>
        <AnimatePresence initial={false}>
          {!isSourceCheckCollapsed && (
            <motion.div 
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="overflow-hidden"
            >
              <div className="p-6 bg-white/5 rounded-2xl border border-white/5">
                <p className="text-lg text-foreground/80 leading-relaxed font-medium">{sourceCheck}</p>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>

      {/* 6. Research Result Card */}
      <motion.div 
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="glass p-10 rounded-[40px] space-y-6 hover:border-accent/20 transition-all duration-500"
      >
        <button 
          onClick={() => setIsResearchResultCollapsed(!isResearchResultCollapsed)}
          className="flex items-center justify-between w-full group"
        >
          <div className="flex items-center gap-3 text-muted-foreground">
            <HelpCircle className="w-4 h-4" />
            <h4 className="text-[10px] uppercase font-black tracking-[0.3em]">Research Result</h4>
          </div>
          <div className="w-8 h-8 rounded-full bg-white/5 flex items-center justify-center text-muted-foreground group-hover:text-accent transition-all">
            {isResearchResultCollapsed ? <ChevronDown className="w-4 h-4" /> : <ChevronUp className="w-4 h-4" />}
          </div>
        </button>
        <AnimatePresence initial={false}>
          {!isResearchResultCollapsed && (
            <motion.div 
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="overflow-hidden"
            >
              <div className="p-6 bg-white/5 rounded-2xl border border-white/5">
                <p className="text-lg text-foreground/80 leading-relaxed font-medium">{researchResult}</p>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>

      {/* 7. Sources Card */}
      {sources.length > 0 && (
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="glass p-10 rounded-[40px] space-y-8 hover:border-accent/20 transition-all duration-500"
        >
          <div className="flex items-center gap-3 text-muted-foreground">
            <ExternalLink className="w-4 h-4" />
            <h4 className="text-[10px] uppercase font-black tracking-[0.3em]">Verification Sources</h4>
          </div>
          <div className="flex flex-wrap gap-3">
            {sources.map((source, i) => {
              let title = source;
              let url = source;
              const firstColonIndex = source.indexOf(':');
              if (firstColonIndex !== -1) {
                const prefix = source.substring(0, firstColonIndex).trim().toLowerCase();
                if (prefix !== 'http' && prefix !== 'https') {
                  title = source.substring(0, firstColonIndex).trim();
                  url = source.substring(firstColonIndex + 1).trim();
                }
              }
              const finalUrl = url.startsWith('http') ? url : (url.startsWith('//') ? `https:${url}` : `https://${url}`);
              return (
                <a 
                  key={i} 
                  href={finalUrl} 
                  target="_blank" 
                  rel="noopener noreferrer"
                  className="px-5 py-3 rounded-xl bg-white/5 border border-white/10 text-xs font-bold text-accent hover:bg-accent hover:text-background transition-all flex items-center gap-2 group"
                >
                  {title.trim()} <ExternalLink className="w-3.5 h-3.5 group-hover:scale-110 transition-transform" />
                </a>
              );
            })}
          </div>
        </motion.div>
      )}

      {/* 8. Explanation Card */}
      {extraContext && (
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="glass p-10 rounded-[40px] space-y-6 hover:border-accent/20 transition-all duration-500"
        >
          <button 
            onClick={() => setIsWhyCollapsed(!isWhyCollapsed)}
            className="flex items-center justify-between w-full group"
          >
            <div className="flex items-center gap-3 text-muted-foreground">
              <Info className="w-4 h-4" />
              <h4 className="text-[10px] uppercase font-black tracking-[0.3em]">Explanation</h4>
            </div>
            <div className="w-8 h-8 rounded-full bg-white/5 flex items-center justify-center text-muted-foreground group-hover:text-accent transition-all">
              {isWhyCollapsed ? <ChevronDown className="w-4 h-4" /> : <ChevronUp className="w-4 h-4" />}
            </div>
          </button>
          <AnimatePresence initial={false}>
            {!isWhyCollapsed && (
              <motion.div 
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                className="overflow-hidden"
              >
                <div className="p-6 bg-white/5 rounded-2xl border border-white/5">
                  <p className="text-lg text-foreground/80 leading-relaxed font-medium">{extraContext}</p>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      )}

      {/* 9. Confidence & Context Footer */}
      <div className="flex flex-wrap items-center justify-between gap-6 pt-6">
        <div className="flex gap-4">
          <div className={`px-4 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest border ${getConfidenceColor(classificationConfidence)}`}>
            Class: {classificationConfidence}
          </div>
          <div className={`px-4 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest border ${getConfidenceColor(verdictConfidence)}`}>
            Verdict: {verdictConfidence}
          </div>
        </div>
        <ShareButtons 
          text={`Fallaxis Verification: ${verdict.toUpperCase()} - ${mainClaims[0] || 'Instagram Content'}`}
          url={window.location.href}
        />
      </div>
    </div>
  );
}

