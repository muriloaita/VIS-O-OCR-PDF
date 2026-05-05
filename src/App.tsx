/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useCallback, useEffect } from 'react';
import { GoogleGenAI } from "@google/genai";
import { 
  FileText, 
  Upload, 
  Loader2, 
  Download, 
  Copy, 
  Check, 
  AlertCircle,
  FileSearch,
  BookOpen
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import ReactMarkdown from 'react-markdown';
import { jsPDF } from 'jspdf';
import { PDFDocument } from 'pdf-lib';
import axios from 'axios';
import JSZip from 'jszip';
import { cn } from './lib/utils';

// --- DATABASE OCR CONFIG ---
const DRIVE_FOLDER_ID = "1-tvAV7zlYYhqcu_qEhb_QCamvZLAe1nk";

//// --- SYSTEM INSTRUCTION (V5: EXTRAÇÃO TOTAL E FIEL) ---
const SYSTEM_INSTRUCTION = `Extraia TODO o texto e todas as informações estruturais com 100% de integridade. 
NÃO RESUMA, NÃO OMITA NADA. Cada caractere, vírgula e número é importante.
Mantenha a estrutura original de tabelas e listas conforme instruído no prompt específico de extração.
Use "--- PÁGINA [N] ---" como separador.`;

export default function App() {
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [debugMode, setDebugMode] = useState(false);
  const [structuredTableMode, setStructuredTableMode] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [result, setResult] = useState<string | null>(null);
  const [debugLog, setDebugLog] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  
  // Google Drive State
  const [googleToken, setGoogleToken] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [splitting, setSplitting] = useState(false);
  const [syncSuccess, setSyncSuccess] = useState(false);
  const [tokensSpent, setTokensSpent] = useState<number>(0);

  // Listen for OAuth Success from popup
  useEffect(() => {
    const handleAuthMessage = (event: MessageEvent) => {
      // Validate origin is from AI Studio preview or localhost
      const origin = event.origin;
      if (!origin.endsWith('.run.app') && !origin.includes('localhost')) {
        return;
      }

      if (event.data?.type === 'GOOGLE_AUTH_SUCCESS') {
        setGoogleToken(event.data.accessToken);
        setSyncSuccess(false);
      }
    };
    window.addEventListener('message', handleAuthMessage);
    return () => window.removeEventListener('message', handleAuthMessage);
  }, []);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (selectedFile && selectedFile.type === 'application/pdf') {
      setFile(selectedFile);
      setError(null);
      setResult(null);
      setDebugLog(null);
      setSyncSuccess(false);
      setProgress({ current: 0, total: 0 });
    } else {
      setError('Por favor, selecione um arquivo PDF válido.');
    }
  };

  const calculateDynamicChunkSize = (totalPages: number) => {
    if (totalPages <= 50) return 10;
    if (totalPages <= 200) return 30;
    if (totalPages <= 500) return 50;
    return 80; // Máximo para manter estabilidade e progressão
  };

  const processOCR = async () => {
    if (!file) return;

    setLoading(true);
    setError(null);
    setResult("");
    setDebugLog(null);
    setSyncSuccess(false);
    setTokensSpent(0);
    
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      const arrayBuffer = await file.arrayBuffer();
      const pdfDoc = await PDFDocument.load(arrayBuffer);
      const totalPages = pdfDoc.getPageCount();
      
      const CHUNK_SIZE = calculateDynamicChunkSize(totalPages);
      const totalChunks = Math.ceil(totalPages / CHUNK_SIZE);
      setProgress({ current: 0, total: totalChunks });

      let fullResult = "";
      let fullDebug = "";

      for (let i = 0; i < totalPages; i += CHUNK_SIZE) {
        const currentChunkIndex = Math.floor(i / CHUNK_SIZE) + 1;
        setProgress(prev => ({ ...prev, current: currentChunkIndex }));
        
        const start = i;
        const end = Math.min(i + CHUNK_SIZE, totalPages);
        
        const chunkDoc = await PDFDocument.create();
        const pageIndices = Array.from({ length: end - start }, (_, idx) => start + idx);
        const copiedPages = await chunkDoc.copyPages(pdfDoc, pageIndices);
        copiedPages.forEach(page => chunkDoc.addPage(page));
        
        const chunkBase64 = await chunkDoc.saveAsBase64();

        const debugPrompt = debugMode ? "\nInclua ao final um diagnóstico das páginas ignoradas neste lote e o motivo." : "";
        const tablePrompt = structuredTableMode ? "\nPARA TABELAS: Extraia EXCLUSIVAMENTE em formato JSON estruturado (array de objetos). Se a estrutura for impossível de capturar em JSON, use uma lista de tópicos (bullet points) extremamente detalhada e fiel. NÃO use Markdown para tabelas se este modo estiver ativo." : "\nPARA TABELAS: Use formato Markdown para tabelas.";

        const response = await ai.models.generateContent({
          model: "gemini-3-flash-preview",
          contents: [
            {
              parts: [
                {
                  inlineData: {
                    mimeType: "application/pdf",
                    data: chunkBase64
                  }
                },
                {
                  text: `Extraia os dados deste lote (${start + 1} a ${end}). Remova artefatos e limpe caracteres especiais.${debugPrompt}${tablePrompt}`
                }
              ]
            }
          ],
          config: {
            systemInstruction: SYSTEM_INSTRUCTION,
          },
        });

        const textOutput = response.text;
        const usage = response.usageMetadata;
        if (usage?.totalTokenCount) {
          setTokensSpent(prev => prev + usage.totalTokenCount);
        }
        if (textOutput) {
          // Separar diagnóstico se existir
          if (debugMode && textOutput.includes("DIAGNÓSTICO")) {
            const parts = textOutput.split(/### DIAGNÓSTICO DE PÁGINAS IGNORADAS:?/);
            fullResult += (fullResult ? "\n\n" : "") + parts[0].trim();
            if (parts[1]) fullDebug += (fullDebug ? "\n" : "") + parts[1].trim();
          } else {
            fullResult += (fullResult ? "\n\n" : "") + textOutput;
          }
          setResult(fullResult);
          if (fullDebug) setDebugLog(fullDebug);
        }
      }

      if (!fullResult && !fullDebug) {
        throw new Error("Não foi possível extrair conteúdo útil do documento.");
      }
    } catch (err: any) {
      console.error(err);
      let errorMessage = "Erro crítico no processamento. Verifique o arquivo.";
      if (err?.message?.includes("API_KEY")) errorMessage = "Chave API inválida.";
      setError(errorMessage);
    } finally {
      setLoading(false);
      setProgress({ current: 0, total: 0 });
    }
  };

  const connectGoogleDrive = async () => {
    try {
      const response = await fetch('/api/auth/google/url');
      if (!response.ok) throw new Error('Falha ao obter URL de autenticação');
      const { url } = await response.json();
      
      const width = 600;
      const height = 700;
      const left = window.innerWidth / 2 - width / 2;
      const top = window.innerHeight / 2 - height / 2;
      
      window.open(
        url,
        'google_auth',
        `width=${width},height=${height},left=${left},top=${top}`
      );
    } catch (err) {
      console.error(err);
      setError("Erro ao conectar com Google Drive.");
    }
  };

  const downloadSplitZip = async () => {
    if (!file) return;
    setSplitting(true);
    try {
      const arrayBuffer = await file.arrayBuffer();
      const pdfDoc = await PDFDocument.load(arrayBuffer);
      const totalPages = pdfDoc.getPageCount();
      const CHUNK_SIZE = calculateDynamicChunkSize(totalPages);
      
      const zip = new JSZip();
      const totalChunks = Math.ceil(totalPages / CHUNK_SIZE);
      
      for (let i = 0; i < totalPages; i += CHUNK_SIZE) {
        const start = i;
        const end = Math.min(i + CHUNK_SIZE, totalPages);
        
        const chunkDoc = await PDFDocument.create();
        const pageIndices = Array.from({ length: end - start }, (_, idx) => start + idx);
        const copiedPages = await chunkDoc.copyPages(pdfDoc, pageIndices);
        copiedPages.forEach(page => chunkDoc.addPage(page));
        
        const chunkBytes = await chunkDoc.save();
        zip.file(`lote_${Math.floor(i/CHUNK_SIZE) + 1}_paginas_${start+1}-${end}.pdf`, chunkBytes);
      }
      
      const content = await zip.generateAsync({ type: "blob" });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(content);
      link.download = `${file.name.replace('.pdf', '')}_dividido.zip`;
      link.click();
    } catch (err) {
      console.error(err);
      setError("Erro ao dividir o PDF.");
    } finally {
      setSplitting(false);
    }
  };

  const saveToDrive = async () => {
    if (!result || !googleToken || !file) return;
    
    setSyncing(true);
    setSyncSuccess(false);
    
    try {
      // 1. Salvar o arquivo Original (PDF)
      const pdfMetadata = {
        name: `ORIGINAL_${file.name}`,
        parents: [DRIVE_FOLDER_ID],
        mimeType: file.type
      };

      const pdfData = new FormData();
      pdfData.append('metadata', new Blob([JSON.stringify(pdfMetadata)], { type: 'application/json' }));
      pdfData.append('file', file);

      await axios.post(
        'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
        pdfData,
        {
          headers: {
            Authorization: `Bearer ${googleToken}`,
            'Content-Type': 'multipart/related'
          }
        }
      );

      // 2. Salvar a Extração (Markdown)
      const fileName = `DATABASE_OCR_${file.name.replace('.pdf', '')}_${new Date().getTime()}.md`;
      const metadata = {
        name: fileName,
        parents: [DRIVE_FOLDER_ID],
        mimeType: 'text/markdown'
      };

      const formData = new FormData();
      formData.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
      formData.append('file', new Blob([result], { type: 'text/markdown' }));

      await axios.post(
        'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
        formData,
        {
          headers: {
            Authorization: `Bearer ${googleToken}`,
            'Content-Type': 'multipart/related'
          }
        }
      );

      setSyncSuccess(true);
    } catch (err: any) {
      console.error("Drive upload error:", err.response?.data || err.message);
      setError("Falha ao salvar no Google Drive. Verifique a conexão.");
      if (err.response?.status === 401) setGoogleToken(null);
    } finally {
      setSyncing(false);
    }
  };

  const copyToClipboard = () => {
    if (result) {
      navigator.clipboard.writeText(result);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const downloadPDF = () => {
    if (!result) return;
    const doc = new jsPDF();
    const margin = 10;
    const pageWidth = doc.internal.pageSize.getWidth();
    const splitText = doc.splitTextToSize(result, pageWidth - margin * 2);
    doc.text(splitText, margin, 20);
    doc.save('extracao-ocr.pdf');
  };

  return (
    <div className="min-h-screen bg-[#F5F5F3] text-[#1A1A1A] font-sans selection:bg-[#1A1A1A] selection:text-white">
      {/* Header */}
      <header className="border-b border-black/10 bg-white/80 backdrop-blur-md sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-[#1A1A1A] flex items-center justify-center rounded-lg">
              <FileSearch className="text-white w-6 h-6" />
            </div>
            <div>
              <h1 className="font-bold text-xl tracking-tight uppercase">Visão OCR Pro</h1>
              <p className="text-[10px] uppercase tracking-widest opacity-50 font-semibold font-mono">Ferramenta Especialista em Visão Computacional</p>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2 px-3 py-1 bg-black/5 rounded-full cursor-pointer hover:bg-black/10 transition-colors" onClick={() => setDebugMode(!debugMode)}>
              <div className={cn("w-2 h-2 rounded-full", debugMode ? "bg-orange-500 animate-pulse" : "bg-gray-300")} />
              <span className="text-[10px] font-mono font-bold opacity-70 uppercase">DEPURAÇÃO: {debugMode ? "LIGADA" : "DESLIGADA"}</span>
            </div>
            <div className="flex items-center gap-2 px-3 py-1 bg-black/5 rounded-full cursor-pointer hover:bg-black/10 transition-colors" onClick={() => setStructuredTableMode(!structuredTableMode)}>
              <div className={cn("w-2 h-2 rounded-full", structuredTableMode ? "bg-blue-500 animate-pulse" : "bg-gray-300")} />
              <span className="text-[10px] font-mono font-bold opacity-70 uppercase">TABELAS: {structuredTableMode ? "JSON" : "MARKDOWN"}</span>
            </div>
            <div className="hidden md:flex items-center gap-2 px-3 py-1 bg-black/5 rounded-full">
              <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
              <span className="text-[11px] font-mono font-medium opacity-70">SISTEMA ONLINE</span>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-12">
        <div className="grid lg:grid-cols-12 gap-8">
          
          {/* Sidebar / Upload Area */}
          <div className="lg:col-span-4 space-y-6">
            <section className="bg-white border border-black/10 rounded-2xl p-6 shadow-sm">
              <h2 className="text-xs font-bold uppercase tracking-widest mb-6 flex items-center gap-2">
                <Upload className="w-3 h-3" />
                Upload de Documento
              </h2>
              
              <div 
                className={cn(
                  "relative border-2 border-dashed rounded-xl transition-all duration-300 group",
                  file ? "border-green-500/50 bg-green-50/30" : "border-black/10 hover:border-black/30 bg-gray-50/50"
                )}
              >
                <input
                  type="file"
                  accept=".pdf"
                  onChange={handleFileChange}
                  className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10"
                />
                <div className="p-8 text-center">
                  <div className="mb-4 flex justify-center">
                    {file ? (
                      <div className="bg-green-500 text-white p-3 rounded-full animate-in zoom-in duration-300">
                        <Check className="w-6 h-6" />
                      </div>
                    ) : (
                      <div className="bg-black/5 p-4 rounded-full group-hover:scale-110 transition-transform">
                        <FileText className="w-8 h-8 opacity-40" />
                      </div>
                    )}
                  </div>
                  <p className="text-sm font-semibold mb-1">
                    {file ? file.name : "Arraste seu PDF aqui"}
                  </p>
                  <p className="text-[11px] opacity-50 uppercase tracking-wider font-medium">
                    {file ? `${(file.size / 1024 / 1024).toFixed(2)} MB` : "ou clique para navegar"}
                  </p>
                </div>
              </div>

              <button
                onClick={processOCR}
                disabled={!file || loading}
                className={cn(
                  "w-full mt-6 py-4 rounded-xl font-bold uppercase tracking-widest flex items-center justify-center gap-3 transition-all",
                  file && !loading 
                    ? "bg-[#1A1A1A] text-white hover:bg-black active:scale-[0.98] shadow-lg shadow-black/10" 
                    : "bg-black/5 text-black/30 cursor-not-allowed"
                )}
              >
                {loading ? (
                  <div className="flex flex-col items-center gap-2">
                    <div className="flex items-center gap-2">
                      <Loader2 className="w-5 h-5 animate-spin" />
                      <span>{progress.total > 1 ? `Processando Lote ${progress.current}/${progress.total}` : "Processando..."}</span>
                    </div>
                    {progress.total > 1 && (
                      <div className="w-full h-1 bg-white/20 rounded-full mt-1 overflow-hidden">
                        <motion.div 
                          className="h-full bg-blue-500"
                          initial={{ width: 0 }}
                          animate={{ width: `${(progress.current / progress.total) * 100}%` }}
                        />
                      </div>
                    )}
                  </div>
                ) : (
                  <>
                    <FileSearch className="w-5 h-5" />
                    Iniciar OCR
                  </>
                )}
              </button>

              {file && !loading && (
                <button
                  onClick={downloadSplitZip}
                  disabled={splitting}
                  className="w-full mt-3 py-3 rounded-xl border border-black/10 text-[10px] font-bold uppercase tracking-widest flex items-center justify-center gap-2 hover:bg-black/5 transition-all text-black/60"
                >
                  {splitting ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Download className="w-4 h-4" />
                  )}
                  {splitting ? "Dividindo..." : "Baixar PDF Dividido (ZIP)"}
                </button>
              )}

              {error && (
                <div className="mt-4 p-4 bg-red-50 border border-red-100 rounded-xl flex items-start gap-3 animate-in slide-in-from-top-2">
                  <AlertCircle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
                  <p className="text-[11px] font-semibold text-red-800 leading-relaxed uppercase">
                    {error}
                  </p>
                </div>
              )}
            </section>

            <section className="bg-black text-white rounded-2xl p-6 overflow-hidden relative group">
              <div className="relative z-10">
                <h3 className="text-xs font-bold uppercase tracking-widest mb-2 opacity-50">Estatísticas do Modelo</h3>
                <div className="space-y-4 pt-2">
                  <div className="flex justify-between items-end border-b border-white/10 pb-2">
                    <span className="text-[10px] uppercase opacity-40">Motor AI</span>
                    <span className="text-xs font-mono font-bold tracking-tighter">Gemini 3 Flash</span>
                  </div>
                  <div className="flex justify-between items-end border-b border-white/10 pb-2">
                    <span className="text-[10px] uppercase opacity-40">Nível de Precisão</span>
                    <span className="text-xs font-mono font-bold tracking-tighter">Alta Fidelidade (OCR+)</span>
                  </div>
                  <div className="flex justify-between items-end border-b border-white/10 pb-2">
                    <span className="text-[10px] uppercase opacity-40">Latência Est.</span>
                    <span className="text-xs font-mono font-bold tracking-tighter">~120ms/pag</span>
                  </div>
                  <div className="flex justify-between items-end border-b border-white/10 pb-2">
                    <span className="text-[10px] uppercase opacity-40">Tokens Processados</span>
                    <span className="text-xs font-mono font-bold tracking-tighter">{tokensSpent.toLocaleString()}</span>
                  </div>
                  <div className="pt-4">
                    <a 
                      href="https://drive.google.com/drive/folders/1-tvAV7zlYYhqcu_qEhb_QCamvZLAe1nk?usp=sharing"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-2 text-[10px] uppercase font-bold text-blue-400 hover:text-blue-300 transition-colors group"
                    >
                      <div className="bg-blue-500/20 p-1 rounded group-hover:bg-blue-500/30">
                        <img src="https://www.gstatic.com/images/branding/product/1x/drive_48dp.png" className="w-3 h-3 invert pointer-events-none" alt="Drive" />
                      </div>
                      Acessar DATABASE_OCR
                    </a>
                  </div>
                </div>
              </div>
              {/* Decorative background element */}
              <div className="absolute -right-4 -bottom-4 opacity-5 group-hover:opacity-10 transition-opacity">
                <BookOpen className="w-32 h-32 rotate-12" />
              </div>
            </section>
          </div>

          {/* Results Area */}
          <div className="lg:col-span-8 flex flex-col h-full min-h-[600px]">
            <div className="bg-white border border-black/10 rounded-2xl shadow-sm flex flex-col flex-1 overflow-hidden">
              <div className="px-6 py-4 border-b border-black/10 flex items-center justify-between bg-white sticky top-0 z-10">
                <div className="flex items-center gap-3">
                  <div className="w-2 h-2 rounded-full bg-blue-500" />
                  <h2 className="text-xs font-bold uppercase tracking-widest">Painel de Resultados</h2>
                </div>
                
                <AnimatePresence>
                  {result && (
                    <motion.div 
                      initial={{ opacity: 0, x: 20 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: 20 }}
                      className="flex items-center gap-2"
                    >
                      {googleToken ? (
                        <button 
                          onClick={saveToDrive}
                          disabled={syncing}
                          className={cn(
                            "p-2 rounded-lg transition-all flex items-center gap-2 group",
                            syncSuccess ? "bg-green-50 text-green-700" : "hover:bg-black/5"
                          )}
                        >
                          {syncing ? (
                            <Loader2 className="w-4 h-4 animate-spin text-blue-500" />
                          ) : syncSuccess ? (
                            <Check className="w-4 h-4" />
                          ) : (
                            <div className="bg-blue-100 p-0.5 rounded shadow-sm">
                              <img src="https://www.gstatic.com/images/branding/product/1x/drive_48dp.png" className="w-3 h-3" alt="Drive" />
                            </div>
                          )}
                          <span className="text-[10px] font-bold uppercase tracking-wider">
                            {syncing ? "Sincronizando..." : syncSuccess ? "Salvo no DB" : "Sincronizar no Drive"}
                          </span>
                        </button>
                      ) : (
                        <button 
                          onClick={connectGoogleDrive}
                          className="p-2 hover:bg-black/5 rounded-lg transition-colors flex items-center gap-2 group"
                        >
                          <div className="bg-white p-0.5 rounded shadow-sm border border-black/5">
                            <img src="https://www.gstatic.com/images/branding/product/1x/drive_48dp.png" className="w-3 h-3" alt="Drive" />
                          </div>
                          <span className="text-[10px] font-bold uppercase tracking-wider opacity-40 group-hover:opacity-100 italic">Conectar Drive</span>
                        </button>
                      )}
                      
                      <div className="w-[1px] h-4 bg-black/10 mx-2" />
                      <button 
                        onClick={copyToClipboard}
                        className="p-2 hover:bg-black/5 rounded-lg transition-colors flex items-center gap-2 group"
                      >
                        {copied ? <Check className="w-4 h-4 text-green-600" /> : <Copy className="w-4 h-4 opacity-40 group-hover:opacity-100" />}
                        <span className="text-[10px] font-bold uppercase tracking-wider">{copied ? "Copiado" : "Copiar"}</span>
                      </button>
                      <div className="w-[1px] h-4 bg-black/10 mx-2" />
                      <button 
                        onClick={downloadPDF}
                        className="p-2 hover:bg-black/5 rounded-lg transition-colors flex items-center gap-2 group"
                      >
                        <Download className="w-4 h-4 opacity-40 group-hover:opacity-100" />
                        <span className="text-[10px] font-bold uppercase tracking-wider">Exportar PDF</span>
                      </button>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>

              <div className={cn(
                "flex-1 p-8 overflow-y-auto font-mono text-[13px] leading-relaxed relative",
                !result && "flex items-center justify-center"
              )}>
                {debugMode && debugLog && (
                  <div className="absolute right-4 top-4 z-20 max-w-[200px] bg-orange-50/90 border border-orange-200 rounded-lg p-3 shadow-xl backdrop-blur-sm animate-in slide-in-from-right-4">
                    <h4 className="text-[9px] font-bold uppercase text-orange-800 mb-2 border-b border-orange-200 pb-1">Log de Depuração</h4>
                    <pre className="text-[8px] text-orange-700 whitespace-pre-wrap leading-tight">{debugLog}</pre>
                  </div>
                )}
                {!result ? (
                  <div className="text-center max-w-sm space-y-4 opacity-30 select-none">
                    <div className="flex justify-center">
                      <div className={cn(
                        "p-8 border-4 border-dashed border-black/10 rounded-full",
                        loading && "animate-pulse border-blue-500 bg-blue-50/50"
                      )}>
                        <FileText className="w-16 h-16" />
                      </div>
                    </div>
                    <div className="uppercase tracking-[0.2em] font-bold text-xs text-center">
                      {loading ? (
                        <div className="flex flex-col gap-2">
                          <span>
                            {progress.total > 1 
                              ? `Processando lote ${progress.current} de ${progress.total}`
                              : "Analisando Documento..."}
                          </span>
                          {progress.total > 1 && (
                            <div className="w-48 h-1.5 bg-black/5 rounded-full overflow-hidden mx-auto border border-black/5">
                              <motion.div 
                                className="h-full bg-blue-600"
                                initial={{ width: 0 }}
                                animate={{ width: `${(progress.current / progress.total) * 100}%` }}
                                transition={{ type: "spring", bounce: 0, duration: 0.5 }}
                              />
                            </div>
                          )}
                        </div>
                      ) : "Aguardando Input..."}
                    </div>
                    <p className="text-[10px] font-medium leading-normal italic px-4">
                      {loading 
                        ? "Filtrando ruídos e descartando páginas em branco para uma extração limpa."
                        : '"A visão computacional está pronta para ler sua data estruturada."'}
                    </p>
                  </div>
                ) : (
                  <motion.div 
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="prose prose-sm max-w-none prose-pre:bg-black/5 prose-pre:text-black prose-table:border prose-table:border-black/10 prose-th:bg-black/5 prose-th:p-2 prose-td:p-2 prose-td:border prose-td:border-black/10"
                  >
                    <ReactMarkdown>{result}</ReactMarkdown>
                  </motion.div>
                )}
              </div>
              
              {/* Status Bar */}
              {result && (
                <div className="px-6 py-2 bg-black/[0.02] border-t border-black/10 flex justify-between items-center shrink-0">
                  <span className="text-[9px] font-mono opacity-40 uppercase font-bold tracking-widest">
                    Extração Concluída com Sucesso
                  </span>
                  <div className="flex items-center gap-4">
                    <span className="text-[9px] font-mono opacity-40 uppercase font-bold tracking-widest">
                      Palavras: {result.split(/\s+/).length}
                    </span>
                    <span className="text-[9px] font-mono opacity-40 uppercase font-bold tracking-widest">
                      Caracteres: {result.length}
                    </span>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </main>

      {/* Footer Decoration */}
      <footer className="mt-auto py-12 px-6">
        <div className="max-w-7xl mx-auto border-t border-black/5 pt-8 flex flex-col md:flex-row justify-between items-center gap-6 opacity-40 hover:opacity-100 transition-opacity">
          <div className="flex items-center gap-6">
            <span className="text-[10px] font-bold uppercase tracking-[0.2em]">Especialista em OCR de Alta Precisão</span>
            <div className="w-[1px] h-3 bg-black" />
            <span className="text-[10px] font-bold uppercase tracking-[0.2em]">Tecnologia Gemini 3</span>
          </div>
          <div className="flex items-center gap-4 grayscale">
            <div className="w-8 h-8 rounded bg-black/10" />
            <div className="w-8 h-8 rounded bg-black/10" />
            <div className="w-8 h-8 rounded bg-black/10" />
          </div>
        </div>
      </footer>
    </div>
  );
}
