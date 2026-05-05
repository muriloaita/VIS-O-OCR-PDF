/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useCallback } from 'react';
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
  BookOpen,
  Settings2
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import ReactMarkdown from 'react-markdown';
import { jsPDF } from 'jspdf';
import { PDFDocument } from 'pdf-lib';
import { cn } from './lib/utils';

/// --- SYSTEM INSTRUCTION (OCR CIRÚRGICO: FILTRAGEM DE RUÍDO E PÁGINAS VAZIAS) ---
const SYSTEM_INSTRUCTION = `Atue como um Especialista em OCR Forense de Ultra-Alta Precisão.

Missão: Extrair apenas o texto ÚTIL e LEGÍVEL do documento, eliminando qualquer elemento não textual ou ruidoso.

Diretrizes de Limpeza e Eficiência:
1. PÁGINAS EM BRANCO/INÚTEIS: Se uma página não contiver texto legível (ex: for apenas uma folha em branco, apenas sombras, ou apenas borrões), IGNORE-A. Não gere cabeçalho nem conteúdo para ela.
2. FILTRAGEM DE ARTEFATOS: Ignore agressivamente: marcas de furos de pasta, grampos, sombras de digitalização nas bordas, manchas de café/sujeira, e carimbos que não contenham texto legível.
3. FOCO TEXTUAL: Ignore elementos puramente decorativos, logos sem texto associado, ou marcas d'água de fundo que não prejudiquem o texto principal.
4. ESTRUTURAÇÃO LIMPA: Use Markdown básico para títulos e listas. 
5. TABELAS: Apenas transcreva como tabela se os dados forem claros. Caso contrário, organize como uma lista de tópicos estruturada para evitar poluição visual.
6. ZERO ADIVINHAÇÃO: Se uma palavra estiver ilegível devido a ruído, use [?]. Nunca invente texto.

Formato:
Use "--- PÁGINA [N] ---" como separador APENAS para páginas que contenham texto relevante. Não mencione páginas ignoradas.`;

export default function App() {
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (selectedFile && selectedFile.type === 'application/pdf') {
      setFile(selectedFile);
      setError(null);
      setResult(null);
      setProgress({ current: 0, total: 0 });
    } else {
      setError('Por favor, selecione um arquivo PDF válido.');
    }
  };

  const processOCR = async () => {
    if (!file) return;

    setLoading(true);
    setError(null);
    setResult("");
    
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      const arrayBuffer = await file.arrayBuffer();
      const pdfDoc = await PDFDocument.load(arrayBuffer);
      const totalPages = pdfDoc.getPageCount();
      
      const CHUNK_SIZE = 50; // Lotes menores para progresso constante e segurança de tokens
      const totalChunks = Math.ceil(totalPages / CHUNK_SIZE);
      setProgress({ current: 0, total: totalChunks });

      let fullResult = "";

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
                  text: `Processe este lote de páginas (${start + 1} a ${end}). Gere a transcrição limpa seguindo o prompt de sistema.`
                }
              ]
            }
          ],
          config: {
            systemInstruction: SYSTEM_INSTRUCTION,
          },
        });

        const textOutput = response.text;
        if (textOutput) {
          fullResult += (fullResult ? "\n\n" : "") + textOutput;
          setResult(fullResult);
        }
      }

      if (!fullResult) {
        throw new Error("Não foi possível extrair texto do documento.");
      }
    } catch (err: any) {
      console.error(err);
      let errorMessage = "Erro ao processar o arquivo. Tente novamente.";
      if (err?.message?.includes("page limit")) {
        errorMessage = "O documento é muito extenso para as cotas atuais da API.";
      }
      setError(errorMessage);
    } finally {
      setLoading(false);
      setProgress({ current: 0, total: 0 });
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
              <p className="text-[10px] uppercase tracking-widest opacity-50 font-semibold font-mono">Specialist Computer Vision Tool</p>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <div className="hidden md:flex items-center gap-2 px-3 py-1 bg-black/5 rounded-full">
              <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
              <span className="text-[11px] font-mono font-medium opacity-70">SISTEMA ONLINE</span>
            </div>
            <Settings2 className="w-5 h-5 opacity-40 hover:opacity-100 cursor-pointer transition-opacity" />
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
                "flex-1 p-8 overflow-y-auto font-mono text-[13px] leading-relaxed",
                !result && "flex items-center justify-center"
              )}>
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
                    <p className="uppercase tracking-[0.2em] font-bold text-xs">
                      {loading ? (
                        <div className="flex flex-col gap-2">
                          <span>
                            {progress.total > 1 
                              ? `Processando lote ${progress.current} de ${progress.total}`
                              : "Analizando Documento..."}
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
                    </p>
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
            <span className="text-[10px] font-bold uppercase tracking-[0.2em]">High precision OCR Specialist</span>
            <div className="w-[1px] h-3 bg-black" />
            <span className="text-[10px] font-bold uppercase tracking-[0.2em]">Powered by Gemini 3</span>
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
