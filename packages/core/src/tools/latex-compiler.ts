/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { Config } from '../config/config.js';
import {
  BaseTool,
  ToolResult,
  ToolCallConfirmationDetails,
  ToolExecuteConfirmationDetails,
  ToolConfirmationOutcome,
} from './tools.js';
import { Type } from '@google/genai';
import { SchemaValidator } from '../utils/schemaValidator.js';
import { getErrorMessage } from '../utils/errors.js';
import { makeRelative, shortenPath } from '../utils/paths.js';
import { isWithinRoot } from '../utils/fileUtils.js';
import stripAnsi from 'strip-ansi';

export interface LatexCompilerParams {
  /** The absolute path to the LaTeX file to compile */
  absolute_path: string;
  /** LaTeX compiler to use (pdflatex, xelatex, lualatex, etc.) */
  compiler?: 'pdflatex' | 'xelatex' | 'lualatex' | 'latex' | 'pdflatex-dev' | 'xelatex-dev' | 'lualatex-dev';
  /** Output format (pdf, dvi, ps) */
  output_format?: 'pdf' | 'dvi' | 'ps';
  /** Additional compiler options */
  options?: string[];
  /** Number of compilation passes (default: 1) */
  passes?: number;
  /** Whether to run bibtex/biber for bibliography */
  run_bibtex?: boolean;
  /** Whether to run makeindex for index generation */
  run_makeindex?: boolean;
  /** Output directory for compiled files */
  output_dir?: string;
  /** Whether to clean auxiliary files after compilation */
  clean_aux?: boolean;
  /** Description of the compilation task */
  description?: string;
}

export interface LatexCompilationResult {
  /** Whether compilation was successful */
  success: boolean;
  /** Compiler output (stdout) */
  stdout: string;
  /** Compiler error output (stderr) */
  stderr: string;
  /** Exit code of the compiler */
  exitCode: number | null;
  /** Signal that terminated the process */
  signal: NodeJS.Signals | null;
  /** Path to the output file (if successful) */
  outputPath?: string;
  /** List of auxiliary files created */
  auxFiles: string[];
  /** Compilation warnings */
  warnings: string[];
  /** Compilation errors */
  errors: string[];
  /** Statistics about the compilation */
  stats: {
    pages?: number;
    compilationTime: number;
    passes: number;
  };
}

const OUTPUT_UPDATE_INTERVAL_MS = 500;

export class LatexCompilerTool extends BaseTool<LatexCompilerParams, ToolResult> {
  static readonly Name = 'compile_latex';
  private whitelist: Set<string> = new Set();

  constructor(private readonly config: Config) {
    super(
      LatexCompilerTool.Name,
      'LaTeX Compiler',
      `Compiles LaTeX documents to PDF, DVI, or PS format. Supports multiple LaTeX compilers (pdflatex, xelatex, lualatex) and handles bibliography and index generation.

Features:
- Multiple LaTeX compilers support
- Multi-pass compilation for references
- Bibliography processing (bibtex/biber)
- Index generation (makeindex)
- Auxiliary file management
- Error and warning detection
- Real-time compilation output

The tool returns compilation results including output files, errors, warnings, and statistics.`,
      {
        type: Type.OBJECT,
        properties: {
          absolute_path: {
            type: Type.STRING,
            description: 'The absolute path to the LaTeX file to compile (.tex extension)',
          },
          compiler: {
            type: Type.STRING,
            description: 'LaTeX compiler to use (default: pdflatex)',
            enum: ['pdflatex', 'xelatex', 'lualatex', 'latex', 'pdflatex-dev', 'xelatex-dev', 'lualatex-dev'],
          },
          output_format: {
            type: Type.STRING,
            description: 'Output format (default: pdf)',
            enum: ['pdf', 'dvi', 'ps'],
          },
          options: {
            type: Type.ARRAY,
            description: 'Additional compiler options (e.g., ["-shell-escape", "-synctex=1"])',
            items: {
              type: Type.STRING,
            },
          },
          passes: {
            type: Type.NUMBER,
            description: 'Number of compilation passes (default: 1, max: 5)',
          },
          run_bibtex: {
            type: Type.BOOLEAN,
            description: 'Whether to run bibtex/biber for bibliography processing',
          },
          run_makeindex: {
            type: Type.BOOLEAN,
            description: 'Whether to run makeindex for index generation',
          },
          output_dir: {
            type: Type.STRING,
            description: 'Output directory for compiled files (relative to project root)',
          },
          clean_aux: {
            type: Type.BOOLEAN,
            description: 'Whether to clean auxiliary files after compilation',
          },
          description: {
            type: Type.STRING,
            description: 'Brief description of the compilation task',
          },
        },
        required: ['absolute_path'],
      },
      false, // output is not markdown
      true, // output can be updated
    );
  }

  getDescription(params: LatexCompilerParams): string {
    const relativePath = makeRelative(params.absolute_path, this.config.getTargetDir());
    const compiler = params.compiler || 'pdflatex';
    const format = params.output_format || 'pdf';
    
    let description = `Compile ${shortenPath(relativePath)} with ${compiler} to ${format}`;
    
    if (params.passes && params.passes > 1) {
      description += ` (${params.passes} passes)`;
    }
    
    if (params.run_bibtex) {
      description += ' + bibtex';
    }
    
    if (params.run_makeindex) {
      description += ' + makeindex';
    }
    
    if (params.description) {
      description += ` (${params.description})`;
    }
    
    return description;
  }

  validateToolParams(params: LatexCompilerParams): string | null {
    const errors = SchemaValidator.validate(this.schema.parameters, params);
    if (errors) {
      return errors;
    }

    const filePath = params.absolute_path;
    if (!path.isAbsolute(filePath)) {
      return `File path must be absolute, but was relative: ${filePath}`;
    }

    if (!isWithinRoot(filePath, this.config.getTargetDir())) {
      return `File path must be within the root directory (${this.config.getTargetDir()}): ${filePath}`;
    }

    // Check if file has LaTeX extension
    const ext = path.extname(filePath).toLowerCase();
    if (!['.tex', '.latex'].includes(ext)) {
      return `File must have a LaTeX extension (.tex or .latex), but got: ${ext}`;
    }

    if (!fs.existsSync(filePath)) {
      return `LaTeX file does not exist: ${filePath}`;
    }

    if (params.passes && (params.passes < 1 || params.passes > 5)) {
      return 'Number of passes must be between 1 and 5';
    }

    if (params.output_dir) {
      if (path.isAbsolute(params.output_dir)) {
        return 'Output directory must be relative to the project root directory';
      }
      const outputDir = path.resolve(this.config.getTargetDir(), params.output_dir);
      if (!fs.existsSync(outputDir)) {
        return 'Output directory must exist';
      }
    }

    const fileService = this.config.getFileService();
    if (fileService.shouldGeminiIgnoreFile(params.absolute_path)) {
      return `File path '${filePath}' is ignored by .geminiignore pattern(s)`;
    }

    return null;
  }

  async shouldConfirmExecute(
    params: LatexCompilerParams,
    _abortSignal: AbortSignal,
  ): Promise<ToolCallConfirmationDetails | false> {
    if (this.validateToolParams(params)) {
      return false; // skip confirmation, execute call will fail immediately
    }

    const compiler = params.compiler || 'pdflatex';
    if (this.whitelist.has(compiler)) {
      return false; // already approved and whitelisted
    }

    const relativePath = makeRelative(params.absolute_path, this.config.getTargetDir());
    const confirmationDetails: ToolExecuteConfirmationDetails = {
      type: 'exec',
      title: 'Confirm LaTeX Compilation',
      command: `${compiler} ${shortenPath(relativePath)}`,
      rootCommand: compiler,
      onConfirm: async (outcome: ToolConfirmationOutcome) => {
        if (outcome === ToolConfirmationOutcome.ProceedAlways) {
          this.whitelist.add(compiler);
        }
      },
    };
    return confirmationDetails;
  }

  async execute(
    params: LatexCompilerParams,
    abortSignal: AbortSignal,
    updateOutput?: (output: string) => void,
  ): Promise<ToolResult> {
    const validationError = this.validateToolParams(params);
    if (validationError) {
      return {
        llmContent: `LaTeX compilation failed: ${validationError}`,
        returnDisplay: `Error: ${validationError}`,
      };
    }

    if (abortSignal.aborted) {
      return {
        llmContent: 'LaTeX compilation was cancelled by user before it could start.',
        returnDisplay: 'Compilation cancelled by user.',
      };
    }

    const startTime = Date.now();
    const compiler = params.compiler || 'pdflatex';
    const outputFormat = params.output_format || 'pdf';
    const passes = params.passes || 1;
    const filePath = params.absolute_path;
    const fileName = path.basename(filePath, path.extname(filePath));
    const fileDir = path.dirname(filePath);
    const outputDir = params.output_dir 
      ? path.resolve(this.config.getTargetDir(), params.output_dir)
      : fileDir;

    let allOutput = '';
    let lastUpdateTime = Date.now();

    const appendOutput = (str: string) => {
      allOutput += str;
      if (updateOutput && Date.now() - lastUpdateTime > OUTPUT_UPDATE_INTERVAL_MS) {
        updateOutput(allOutput);
        lastUpdateTime = Date.now();
      }
    };

    try {
      const result = await this.compileLatex(
        filePath,
        compiler,
        outputFormat,
        passes,
        params,
        abortSignal,
        appendOutput,
      );

      const compilationTime = Date.now() - startTime;
      result.stats.compilationTime = compilationTime;

      // Format the result
      const relativePath = makeRelative(filePath, this.config.getTargetDir());
      let llmContent = `LaTeX Compilation Results\n\n`;
      llmContent += `File: ${relativePath}\n`;
      llmContent += `Compiler: ${compiler}\n`;
      llmContent += `Output Format: ${outputFormat}\n`;
      llmContent += `Passes: ${result.stats.passes}\n`;
      llmContent += `Compilation Time: ${compilationTime}ms\n`;
      llmContent += `Success: ${result.success}\n`;
      llmContent += `Exit Code: ${result.exitCode ?? '(none)'}\n`;
      llmContent += `Signal: ${result.signal ?? '(none)'}\n\n`;

      if (result.outputPath) {
        const relativeOutputPath = makeRelative(result.outputPath, this.config.getTargetDir());
        llmContent += `Output File: ${relativeOutputPath}\n`;
      }

      if (result.stats.pages) {
        llmContent += `Pages: ${result.stats.pages}\n`;
      }

      if (result.auxFiles.length > 0) {
        llmContent += `Auxiliary Files: ${result.auxFiles.map(f => path.basename(f)).join(', ')}\n`;
      }

      if (result.warnings.length > 0) {
        llmContent += `\nWarnings (${result.warnings.length}):\n`;
        result.warnings.forEach((warning, i) => {
          llmContent += `${i + 1}. ${warning}\n`;
        });
      }

      if (result.errors.length > 0) {
        llmContent += `\nErrors (${result.errors.length}):\n`;
        result.errors.forEach((error, i) => {
          llmContent += `${i + 1}. ${error}\n`;
        });
      }

      if (result.stdout) {
        llmContent += `\nCompiler Output:\n${result.stdout}\n`;
      }

      if (result.stderr) {
        llmContent += `\nCompiler Errors:\n${result.stderr}\n`;
      }

      // Clean auxiliary files if requested
      if (params.clean_aux && result.success) {
        await this.cleanAuxiliaryFiles(result.auxFiles);
        llmContent += `\nCleaned auxiliary files.\n`;
      }

      let displaySummary = `LaTeX compilation ${result.success ? 'succeeded' : 'failed'}`;
      if (result.success && result.stats.pages) {
        displaySummary += ` (${result.stats.pages} pages)`;
      }
      if (result.warnings.length > 0) {
        displaySummary += ` with ${result.warnings.length} warnings`;
      }
      if (result.errors.length > 0) {
        displaySummary += ` and ${result.errors.length} errors`;
      }

      return {
        llmContent,
        returnDisplay: displaySummary,
      };
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      return {
        llmContent: `LaTeX compilation failed: ${errorMessage}`,
        returnDisplay: `Error: ${errorMessage}`,
      };
    }
  }

  private async compileLatex(
    filePath: string,
    compiler: string,
    outputFormat: string,
    passes: number,
    params: LatexCompilerParams,
    abortSignal: AbortSignal,
    appendOutput: (str: string) => void,
  ): Promise<LatexCompilationResult> {
    const fileName = path.basename(filePath, path.extname(filePath));
    const fileDir = path.dirname(filePath);
    const outputDir = params.output_dir 
      ? path.resolve(this.config.getTargetDir(), params.output_dir)
      : fileDir;

    let allStdout = '';
    let allStderr = '';
    let finalExitCode: number | null = null;
    let finalSignal: NodeJS.Signals | null = null;
    const auxFiles: string[] = [];
    const warnings: string[] = [];
    const errors: string[] = [];

    // Build compiler arguments
    const args = [
      '-interaction=nonstopmode',
      '-file-line-error',
      `-output-directory=${outputDir}`,
    ];

    // Add output format specific arguments
    if (outputFormat === 'dvi' && compiler === 'latex') {
      // latex produces DVI by default
    } else if (outputFormat === 'pdf') {
      if (compiler === 'latex') {
        args.push('-output-format=pdf');
      }
      // pdflatex, xelatex, lualatex produce PDF by default
    }

    // Add custom options
    if (params.options) {
      args.push(...params.options);
    }

    args.push(filePath);

    appendOutput(`Starting LaTeX compilation with ${compiler}...\n`);
    appendOutput(`Command: ${compiler} ${args.join(' ')}\n\n`);

    // Perform compilation passes
    for (let pass = 1; pass <= passes; pass++) {
      appendOutput(`=== Pass ${pass}/${passes} ===\n`);
      
      const result = await this.runCompiler(
        compiler,
        args,
        fileDir,
        abortSignal,
        appendOutput,
      );

      allStdout += result.stdout;
      allStderr += result.stderr;
      finalExitCode = result.exitCode;
      finalSignal = result.signal;

      if (result.exitCode !== 0 || abortSignal.aborted) {
        break;
      }

      // Extract warnings and errors from output
      this.extractWarningsAndErrors(result.stdout, warnings, errors);
    }

    // Run bibtex if requested
    if (params.run_bibtex && finalExitCode === 0 && !abortSignal.aborted) {
      appendOutput(`\n=== Running BibTeX ===\n`);
      const auxFile = path.join(outputDir, `${fileName}.aux`);
      if (fs.existsSync(auxFile)) {
        const bibtexResult = await this.runBibtex(auxFile, abortSignal, appendOutput);
        allStdout += bibtexResult.stdout;
        allStderr += bibtexResult.stderr;
        
        // Run one more LaTeX pass after bibtex
        if (bibtexResult.exitCode === 0) {
          appendOutput(`\n=== Final LaTeX pass after BibTeX ===\n`);
          const finalResult = await this.runCompiler(
            compiler,
            args,
            fileDir,
            abortSignal,
            appendOutput,
          );
          allStdout += finalResult.stdout;
          allStderr += finalResult.stderr;
          finalExitCode = finalResult.exitCode;
          finalSignal = finalResult.signal;
        }
      }
    }

    // Run makeindex if requested
    if (params.run_makeindex && finalExitCode === 0 && !abortSignal.aborted) {
      appendOutput(`\n=== Running MakeIndex ===\n`);
      const idxFile = path.join(outputDir, `${fileName}.idx`);
      if (fs.existsSync(idxFile)) {
        const makeindexResult = await this.runMakeindex(idxFile, abortSignal, appendOutput);
        allStdout += makeindexResult.stdout;
        allStderr += makeindexResult.stderr;
        
        // Run one more LaTeX pass after makeindex
        if (makeindexResult.exitCode === 0) {
          appendOutput(`\n=== Final LaTeX pass after MakeIndex ===\n`);
          const finalResult = await this.runCompiler(
            compiler,
            args,
            fileDir,
            abortSignal,
            appendOutput,
          );
          allStdout += finalResult.stdout;
          allStderr += finalResult.stderr;
          finalExitCode = finalResult.exitCode;
          finalSignal = finalResult.signal;
        }
      }
    }

    // Determine output file path
    const outputExtension = this.getOutputExtension(outputFormat);
    const outputPath = path.join(outputDir, `${fileName}.${outputExtension}`);

    // Find auxiliary files
    this.findAuxiliaryFiles(outputDir, fileName, auxFiles);

    // Extract page count from log file
    const logFile = path.join(outputDir, `${fileName}.log`);
    let pages: number | undefined;
    if (fs.existsSync(logFile)) {
      pages = this.extractPageCount(logFile);
    }

    const success = finalExitCode === 0 && fs.existsSync(outputPath) && !abortSignal.aborted;

    return {
      success,
      stdout: allStdout,
      stderr: allStderr,
      exitCode: finalExitCode,
      signal: finalSignal,
      outputPath: success ? outputPath : undefined,
      auxFiles,
      warnings,
      errors,
      stats: {
        pages,
        compilationTime: 0, // Will be set by caller
        passes,
      },
    };
  }

  private async runCompiler(
    compiler: string,
    args: string[],
    cwd: string,
    abortSignal: AbortSignal,
    appendOutput: (str: string) => void,
  ): Promise<{ stdout: string; stderr: string; exitCode: number | null; signal: NodeJS.Signals | null }> {
    return new Promise((resolve, reject) => {
      const child = spawn(compiler, args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let exitCode: number | null = null;
      let signal: NodeJS.Signals | null = null;

      child.stdout.on('data', (data: Buffer) => {
        const str = stripAnsi(data.toString());
        stdout += str;
        appendOutput(str);
      });

      child.stderr.on('data', (data: Buffer) => {
        const str = stripAnsi(data.toString());
        stderr += str;
        appendOutput(str);
      });

      child.on('error', (error) => {
        reject(error);
      });

      child.on('exit', (code, sig) => {
        exitCode = code;
        signal = sig;
        resolve({ stdout, stderr, exitCode, signal });
      });

      const abortHandler = () => {
        if (child.pid) {
          if (os.platform() === 'win32') {
            spawn('taskkill', ['/pid', child.pid.toString(), '/f', '/t']);
          } else {
            try {
              process.kill(-child.pid, 'SIGTERM');
              setTimeout(() => {
                if (child.pid) {
                  process.kill(-child.pid, 'SIGKILL');
                }
              }, 1000);
            } catch (e) {
              child.kill('SIGKILL');
            }
          }
        }
      };

      abortSignal.addEventListener('abort', abortHandler);
      child.on('exit', () => {
        abortSignal.removeEventListener('abort', abortHandler);
      });
    });
  }

  private async runBibtex(
    auxFile: string,
    abortSignal: AbortSignal,
    appendOutput: (str: string) => void,
  ): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
    const baseFile = path.basename(auxFile, '.aux');
    const cwd = path.dirname(auxFile);
    
    return new Promise((resolve, reject) => {
      const child = spawn('bibtex', [baseFile], {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let exitCode: number | null = null;

      child.stdout.on('data', (data: Buffer) => {
        const str = stripAnsi(data.toString());
        stdout += str;
        appendOutput(str);
      });

      child.stderr.on('data', (data: Buffer) => {
        const str = stripAnsi(data.toString());
        stderr += str;
        appendOutput(str);
      });

      child.on('error', (error) => {
        reject(error);
      });

      child.on('exit', (code) => {
        exitCode = code;
        resolve({ stdout, stderr, exitCode });
      });

      const abortHandler = () => {
        if (child.pid) {
          child.kill('SIGTERM');
        }
      };

      abortSignal.addEventListener('abort', abortHandler);
      child.on('exit', () => {
        abortSignal.removeEventListener('abort', abortHandler);
      });
    });
  }

  private async runMakeindex(
    idxFile: string,
    abortSignal: AbortSignal,
    appendOutput: (str: string) => void,
  ): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
    return new Promise((resolve, reject) => {
      const child = spawn('makeindex', [idxFile], {
        cwd: path.dirname(idxFile),
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let exitCode: number | null = null;

      child.stdout.on('data', (data: Buffer) => {
        const str = stripAnsi(data.toString());
        stdout += str;
        appendOutput(str);
      });

      child.stderr.on('data', (data: Buffer) => {
        const str = stripAnsi(data.toString());
        stderr += str;
        appendOutput(str);
      });

      child.on('error', (error) => {
        reject(error);
      });

      child.on('exit', (code) => {
        exitCode = code;
        resolve({ stdout, stderr, exitCode });
      });

      const abortHandler = () => {
        if (child.pid) {
          child.kill('SIGTERM');
        }
      };

      abortSignal.addEventListener('abort', abortHandler);
      child.on('exit', () => {
        abortSignal.removeEventListener('abort', abortHandler);
      });
    });
  }

  private getOutputExtension(format: string): string {
    switch (format) {
      case 'pdf':
        return 'pdf';
      case 'dvi':
        return 'dvi';
      case 'ps':
        return 'ps';
      default:
        return 'pdf';
    }
  }

  private findAuxiliaryFiles(outputDir: string, fileName: string, auxFiles: string[]): void {
    const auxExtensions = ['.aux', '.log', '.toc', '.lof', '.lot', '.out', '.nav', '.snm', '.fls', '.fdb_latexmk', '.bbl', '.blg', '.idx', '.ind', '.ilg', '.glo', '.gls', '.glg', '.acn', '.acr', '.alg'];
    
    for (const ext of auxExtensions) {
      const auxFile = path.join(outputDir, `${fileName}${ext}`);
      if (fs.existsSync(auxFile)) {
        auxFiles.push(auxFile);
      }
    }
  }

  private extractPageCount(logFile: string): number | undefined {
    try {
      const logContent = fs.readFileSync(logFile, 'utf8');
      const pageMatch = logContent.match(/Output written on .* \((\d+) pages/);
      if (pageMatch) {
        return parseInt(pageMatch[1], 10);
      }
    } catch (error) {
      // Ignore errors reading log file
    }
    return undefined;
  }

  private extractWarningsAndErrors(output: string, warnings: string[], errors: string[]): void {
    const lines = output.split('\n');
    
    for (const line of lines) {
      if (line.includes('Warning:') || line.includes('warning:')) {
        warnings.push(line.trim());
      } else if (line.includes('Error:') || line.includes('error:') || line.includes('!')) {
        errors.push(line.trim());
      }
    }
  }

  private async cleanAuxiliaryFiles(auxFiles: string[]): Promise<void> {
    for (const file of auxFiles) {
      try {
        if (fs.existsSync(file)) {
          fs.unlinkSync(file);
        }
      } catch (error) {
        // Ignore errors cleaning auxiliary files
      }
    }
  }
}