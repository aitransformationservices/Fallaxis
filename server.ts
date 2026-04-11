import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import admin from "firebase-admin";
import { getFirestore } from "firebase-admin/firestore";
import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load Firebase Config
let firebaseConfig: any = {};
try {
  const firebaseConfigPath = path.join(process.cwd(), "firebase-applet-config.json");
  if (fs.existsSync(firebaseConfigPath)) {
    firebaseConfig = JSON.parse(fs.readFileSync(firebaseConfigPath, "utf-8"));
  }
} catch (e) {
  console.error("Error loading firebase-applet-config.json:", e);
}

// Initialize Firebase Admin
const firebaseApp = admin.apps.find(a => a.name === "my-app") 
  || admin.initializeApp({
      projectId: firebaseConfig.projectId,
    }, "my-app");

const db = firebaseConfig.firestoreDatabaseId 
  ? getFirestore(firebaseApp, firebaseConfig.firestoreDatabaseId)
  : getFirestore(firebaseApp);

// Initialize Gemini
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error("GEMINI_API_KEY is not set in environment variables.");
}
const genAI = new GoogleGenAI({ apiKey: apiKey || "dummy-key" });
const embeddingModel = "gemini-embedding-2-preview";
const verificationModel = "gemini-3-flash-preview";

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: "50mb" }));

// Health check endpoint
app.get("/api/health", (req, res) => {
  res.json({ 
    status: "ok", 
    firebase: !!firebaseApp, 
    gemini: !!apiKey,
    project: firebaseConfig.projectId
  });
});

// --- Helper Functions ---

async function getEmbedding(text: string) {
  const result = await genAI.models.embedContent({
    model: embeddingModel,
    contents: [text],
  });
  return result.embeddings[0].values;
}

function cosineSimilarity(vecA: number[], vecB: number[]) {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function updateGlobalStats(status: string, confidence: number) {
  const statsRef = db.collection("stats").doc("global");
  await db.runTransaction(async (transaction) => {
    const statsDoc = await transaction.get(statsRef);
    const stats = statsDoc.exists ? statsDoc.data() : {
      total_claims: 0,
      total_verifications: 0,
      avg_confidence: 0,
      status_distribution: { true: 0, false: 0, misleading: 0, unverified: 0 }
    };

    stats!.total_verifications = (stats!.total_verifications || 0) + 1;
    stats!.status_distribution = stats!.status_distribution || { true: 0, false: 0, misleading: 0, unverified: 0 };
    stats!.status_distribution[status] = (stats!.status_distribution[status] || 0) + 1;
    stats!.avg_confidence = (stats!.avg_confidence * (stats!.total_verifications - 1) + confidence) / stats!.total_verifications;

    transaction.set(statsRef, stats!);
  });
}

// --- API Routes ---

// POST /api/claims/submit
app.post("/api/claims/submit", async (req, res) => {
  try {
    const { 
      claim_text, 
      source_username, 
      image_hash,
      verification_status,
      confidence_score,
      explanation,
      sources
    } = req.body;

    if (!claim_text) return res.status(400).json({ error: "Claim text is required" });

    const embedding = await getEmbedding(claim_text);
    
    // Check for duplicates (simplified semantic search)
    const claimsSnapshot = await db.collection("claims").get();
    let duplicateId = null;
    
    for (const doc of claimsSnapshot.docs) {
      const existingClaim = doc.data();
      if (existingClaim.embedding) {
        const similarity = cosineSimilarity(embedding, existingClaim.embedding);
        if (similarity > 0.92) { // Threshold for semantic duplicate
          duplicateId = doc.id;
          break;
        }
      }
    }

    if (duplicateId) {
      const claimRef = db.collection("claims").doc(duplicateId);
      const updateData: any = {
        times_requested: admin.firestore.FieldValue.increment(1)
      };

      // If client provided a result and the existing one is unverified, update it
      if (verification_status && verification_status !== 'unverified') {
        updateData.verification_status = verification_status;
        updateData.confidence_score = confidence_score || 0;
        updateData.explanation = explanation || "";
        updateData.sources = sources || [];
        updateData.times_verified = admin.firestore.FieldValue.increment(1);
      }

      await claimRef.update(updateData);
      
      if (updateData.verification_status) {
        await updateGlobalStats(updateData.verification_status, updateData.confidence_score);
      }

      return res.json({ id: duplicateId, message: "Duplicate claim found, updated request count.", is_duplicate: true });
    }

    // Create new claim
    const newClaim = {
      claim_text,
      embedding,
      source_username: source_username || "unknown",
      image_hash: image_hash || null,
      date_submitted: admin.firestore.Timestamp.now(),
      verification_status: verification_status || "unverified",
      confidence_score: confidence_score || 0,
      explanation: explanation || "",
      sources: sources || [],
      times_requested: 1,
      times_verified: verification_status && verification_status !== 'unverified' ? 1 : 0,
      user_votes: { true: 0, false: 0, misleading: 0 },
      trending_score: 0
    };

    const docRef = await db.collection("claims").add(newClaim);
    
    // If no result provided, trigger async verification
    if (!verification_status || verification_status === 'unverified') {
      verifyClaim(docRef.id, claim_text).catch(console.error);
    } else {
      await updateGlobalStats(newClaim.verification_status, newClaim.confidence_score);
    }

    // Update global stats for total claims
    await db.collection("stats").doc("global").set({
      total_claims: admin.firestore.FieldValue.increment(1)
    }, { merge: true });

    res.json({ id: docRef.id, message: "Claim submitted for verification.", is_duplicate: false });
  } catch (error) {
    console.error("Error in /api/claims/submit:", error);
    res.status(500).json({ error: "Internal server error", details: error instanceof Error ? error.message : String(error) });
  }
});

async function verifyClaim(claimId: string, text: string) {
  try {
    const response = await genAI.models.generateContent({
      model: verificationModel,
      contents: [{ parts: [{ text: `Verify this claim from Instagram: "${text}". 
      Provide:
      1. Status: true, false, or misleading
      2. Confidence: 0-100
      3. Explanation: 1 paragraph
      4. Sources: list of URLs
      Return as JSON.` }]}],
      config: { 
        responseMimeType: "application/json",
        tools: [{ googleSearch: {} }]
      }
    });

    const result = JSON.parse(response.text);
    const update = {
      verification_status: result.Status.toLowerCase(),
      confidence_score: result.Confidence,
      explanation: result.Explanation,
      sources: result.Sources || [],
      times_verified: admin.firestore.FieldValue.increment(1)
    };

    const claimRef = db.collection("claims").doc(claimId);
    const claimDoc = await claimRef.get();
    if (!claimDoc.exists) {
      console.error(`Claim ${claimId} not found for verification`);
      return;
    }

    await claimRef.update(update);
    await updateGlobalStats(update.verification_status, update.confidence_score);
  } catch (error) {
    console.error("Error in verifyClaim:", error);
  }
}

// GET /api/claims/:id
app.get("/api/claims/:id", async (req, res) => {
  try {
    const doc = await db.collection("claims").doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: "Claim not found" });
    res.json({ id: doc.id, ...doc.data() });
  } catch (error) {
    console.error("Error in /api/claims/:id:", error);
    res.status(500).json({ error: "Internal server error", details: error instanceof Error ? error.message : String(error) });
  }
});

// GET /api/claims/trending
app.get("/api/claims/trending", async (req, res) => {
  try {
    // Update trending scores first (simplified for MVP)
    const snapshot = await db.collection("claims").limit(20).get();
    const now = Date.now();
    
    const trendingClaims = snapshot.docs.map(doc => {
      const data = doc.data();
      const hoursSince = (now - data.date_submitted.toDate().getTime()) / (1000 * 60 * 60);
      const recencyWeight = 1 / (1 + Math.log1p(hoursSince));
      const totalVotes = (data.user_votes?.true || 0) + (data.user_votes?.false || 0) + (data.user_votes?.misleading || 0);
      
      const score = (data.times_requested * 0.5) + (totalVotes * 0.3) + (recencyWeight * 0.2);
      return { id: doc.id, ...data, trending_score: score };
    }).sort((a, b) => b.trending_score - a.trending_score);

    res.json(trendingClaims);
  } catch (error) {
    console.error("Error in /api/claims/trending:", error);
    res.status(500).json({ error: "Internal server error", details: error instanceof Error ? error.message : String(error) });
  }
});

// GET /api/stats/global
app.get("/api/stats/global", async (req, res) => {
  try {
    const doc = await db.collection("stats").doc("global").get();
    const defaultStats = {
      total_claims: 0,
      total_verifications: 0,
      avg_confidence: 0,
      status_distribution: { true: 0, false: 0, misleading: 0, unverified: 0 }
    };
    res.json(doc.exists ? { ...defaultStats, ...doc.data() } : defaultStats);
  } catch (error) {
    console.error("Error in /api/stats/global:", error);
    res.status(500).json({ error: "Internal server error", details: error instanceof Error ? error.message : String(error) });
  }
});

// POST /api/claims/:id/vote
app.post("/api/claims/:id/vote", async (req, res) => {
  try {
    const { vote } = req.body; // 'true', 'false', 'misleading'
    if (!['true', 'false', 'misleading'].includes(vote)) return res.status(400).json({ error: "Invalid vote" });
    
    const claimRef = db.collection("claims").doc(req.params.id);
    await claimRef.update({
      [`user_votes.${vote}`]: admin.firestore.FieldValue.increment(1)
    });
    res.json({ success: true });
  } catch (error) {
    console.error("Error in /api/claims/:id/vote:", error);
    res.status(500).json({ error: "Internal server error", details: error instanceof Error ? error.message : String(error) });
  }
});

// --- Vite Middleware ---

async function startServer() {
  try {
    if (process.env.NODE_ENV !== "production") {
      const vite = await createViteServer({
        server: { middlewareMode: true },
        appType: "spa",
      });
      app.use(vite.middlewares);
    } else {
      const distPath = path.join(process.cwd(), "dist");
      app.use(express.static(distPath));
      app.get("*", (req, res) => {
        res.sendFile(path.join(distPath, "index.html"));
      });
    }

    const PORT = 3000;
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error("Error starting server:", error);
  }
}

startServer();
