/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'path';
import { BaseTool, ToolResult } from './tools.js';
import { Type } from '@google/genai';
import { SchemaValidator } from '../utils/schemaValidator.js';
import { makeRelative, shortenPath } from '../utils/paths.js';
import { isWithinRoot, processSingleFileContent } from '../utils/fileUtils.js';
import { Config } from '../config/config.js';
import { getErrorMessage } from '../utils/errors.js';

/**
 * Represents a mathematical theorem extracted from LaTeX
 */
export interface Theorem {
  /** Type of theorem environment (theorem, lemma, corollary, etc.) */
  type: string;
  /** Optional name/title of the theorem */
  name?: string;
  /** Optional label for referencing */
  label?: string;
  /** The theorem statement content */
  statement: string;
  /** File path where the theorem was found */
  filePath: string;
  /** Line number where the theorem starts */
  lineNumber: number;
  /** Line number where the theorem ends */
  endLineNumber: number;
  /** Raw LaTeX content of the theorem */
  rawContent: string;
  /** References to other theorems or equations */
  references: string[];
  /** Mathematical symbols used in the theorem */
  symbols: string[];
}

/**
 * Parameters for the TheoremExtractor tool
 */
export interface TheoremExtractorParams {
  /** The absolute path to the LaTeX file to analyze */
  absolute_path: string;
  /** Optional: specific theorem types to extract (theorem, lemma, corollary, etc.) */
  theorem_types?: string[];
  /** Optional: whether to extract mathematical symbols */
  extract_symbols?: boolean;
  /** Optional: whether to extract references */
  extract_references?: boolean;
}

/**
 * Result of theorem extraction
 */
export interface TheoremExtractionResult {
  /** List of extracted theorems */
  theorems: Theorem[];
  /** Summary statistics */
  summary: {
    totalTheorems: number;
    theoremsByType: Record<string, number>;
    uniqueSymbols: string[];
    totalReferences: number;
  };
}

/**
 * Tool for extracting and parsing mathematical theorems from LaTeX documents
 */
export class TheoremExtractorTool extends BaseTool<TheoremExtractorParams, ToolResult> {
  static readonly Name = 'extract_theorems';

  constructor(private config: Config) {
    super(
      TheoremExtractorTool.Name,
      'TheoremExtractor',
      'Extracts and parses mathematical theorems from LaTeX documents. Identifies theorem environments, extracts statements, labels, and references.',
      {
        properties: {
          absolute_path: {
            description: 'The absolute path to the LaTeX file to analyze',
            type: Type.STRING,
          },
          theorem_types: {
            description: 'Optional: Array of theorem types to extract (e.g., ["theorem", "lemma", "corollary"]). If not specified, extracts all theorem-like environments.',
            type: Type.ARRAY,
            items: {
              type: Type.STRING,
            },
          },
          extract_symbols: {
            description: 'Optional: Whether to extract mathematical symbols used in theorems (default: true)',
            type: Type.BOOLEAN,
          },
          extract_references: {
            description: 'Optional: Whether to extract references to other theorems/equations (default: true)',
            type: Type.BOOLEAN,
          },
        },
        required: ['absolute_path'],
        type: Type.OBJECT,
      },
      true, // isOutputMarkdown
      false, // canUpdateOutput
    );
  }

  validateToolParams(params: TheoremExtractorParams): string | null {
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

    const fileService = this.config.getFileService();
    if (fileService.shouldGeminiIgnoreFile(params.absolute_path)) {
      return `File path '${filePath}' is ignored by .geminiignore pattern(s).`;
    }

    return null;
  }

  getDescription(params: TheoremExtractorParams): string {
    if (!params || typeof params.absolute_path !== 'string') {
      return 'Extract theorems from LaTeX file';
    }
    const relativePath = makeRelative(params.absolute_path, this.config.getTargetDir());
    const types = params.theorem_types?.length ? ` (${params.theorem_types.join(', ')})` : '';
    return `Extract theorems from ${shortenPath(relativePath)}${types}`;
  }

  async execute(params: TheoremExtractorParams, signal: AbortSignal): Promise<ToolResult> {
    const validationError = this.validateToolParams(params);
    if (validationError) {
      return {
        llmContent: `Error: Invalid parameters. ${validationError}`,
        returnDisplay: validationError,
      };
    }

    try {
      // Read the LaTeX file
      const fileResult = await processSingleFileContent(
        params.absolute_path,
        this.config.getTargetDir(),
      );

      if (fileResult.error) {
        return {
          llmContent: fileResult.error,
          returnDisplay: fileResult.returnDisplay,
        };
      }

      if (typeof fileResult.llmContent !== 'string') {
        return {
          llmContent: 'Error: File content is not text',
          returnDisplay: 'Error: File must be a text file',
        };
      }

      // Extract theorems from the content
      const extractionResult = await this.extractTheorems(
        fileResult.llmContent,
        params.absolute_path,
        params,
        signal,
      );

      // Format the result
      const relativePath = makeRelative(params.absolute_path, this.config.getTargetDir());
      let llmContent = `# Theorem Extraction Results\n\n`;
      llmContent += `**File:** ${relativePath}\n`;
      llmContent += `**Total Theorems:** ${extractionResult.summary.totalTheorems}\n\n`;

      if (extractionResult.summary.totalTheorems === 0) {
        llmContent += 'No theorems found in the specified file.\n';
      } else {
        // Summary by type
        llmContent += `## Summary by Type\n\n`;
        for (const [type, count] of Object.entries(extractionResult.summary.theoremsByType)) {
          llmContent += `- **${type}**: ${count}\n`;
        }
        llmContent += '\n';

        // List all theorems
        llmContent += `## Extracted Theorems\n\n`;
        for (const theorem of extractionResult.theorems) {
          llmContent += `### ${theorem.type.charAt(0).toUpperCase() + theorem.type.slice(1)}`;
          if (theorem.name) {
            llmContent += ` (${theorem.name})`;
          }
          llmContent += `\n\n`;
          
          llmContent += `**Location:** Lines ${theorem.lineNumber}-${theorem.endLineNumber}\n`;
          if (theorem.label) {
            llmContent += `**Label:** ${theorem.label}\n`;
          }
          llmContent += `**Statement:** ${theorem.statement}\n\n`;
          
          if (theorem.references.length > 0) {
            llmContent += `**References:** ${theorem.references.join(', ')}\n`;
          }
          
          if (theorem.symbols.length > 0) {
            llmContent += `**Symbols:** ${theorem.symbols.join(', ')}\n`;
          }
          
          llmContent += `**Raw LaTeX:**\n\`\`\`latex\n${theorem.rawContent}\n\`\`\`\n\n`;
        }

        // Symbol summary
        if (extractionResult.summary.uniqueSymbols.length > 0) {
          llmContent += `## Mathematical Symbols Used\n\n`;
          llmContent += extractionResult.summary.uniqueSymbols.join(', ') + '\n\n';
        }
      }

      const displaySummary = `Found ${extractionResult.summary.totalTheorems} theorems`;

      return {
        llmContent,
        returnDisplay: displaySummary,
      };
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      return {
        llmContent: `Error extracting theorems: ${errorMessage}`,
        returnDisplay: `Error: ${errorMessage}`,
      };
    }
  }

  private async extractTheorems(
    content: string,
    filePath: string,
    params: TheoremExtractorParams,
    signal: AbortSignal,
  ): Promise<TheoremExtractionResult> {
    const theorems: Theorem[] = [];
    const lines = content.split('\n');
    
    // Default theorem types if not specified
    const theoremTypes = params.theorem_types || [
      'theorem', 'lemma', 'corollary', 'proposition', 'definition',
      'example', 'remark', 'proof', 'conjecture', 'axiom'
    ];

    // Create regex patterns for theorem environments
    const beginPattern = new RegExp(
      `\\\\begin\\{(${theoremTypes.join('|')})\\}(?:\\[(.*?)\\])?(?:\\{(.*?)\\})?`,
      'gi'
    );
    const endPattern = /\\end\{([^}]+)\}/gi;

    let match;
    const theoremStack: Array<{
      type: string;
      name?: string;
      label?: string;
      startLine: number;
      startIndex: number;
    }> = [];

    // First pass: find all theorem environments
    while ((match = beginPattern.exec(content)) !== null) {
      if (signal.aborted) {
        throw new Error('Theorem extraction was aborted');
      }

      const [fullMatch, type, name, label] = match;
      const startIndex = match.index;
      const startLine = this.getLineNumber(content, startIndex);

      theoremStack.push({
        type: type.toLowerCase(),
        name,
        label,
        startLine,
        startIndex,
      });
    }

    // Second pass: find matching end environments
    beginPattern.lastIndex = 0; // Reset regex
    let currentTheorem = 0;
    
    while ((match = endPattern.exec(content)) !== null) {
      if (signal.aborted) {
        throw new Error('Theorem extraction was aborted');
      }

      const [fullMatch, endType] = match;
      const endIndex = match.index;
      const endLine = this.getLineNumber(content, endIndex);

      // Find matching theorem start
      for (let i = currentTheorem; i < theoremStack.length; i++) {
        const theorem = theoremStack[i];
        if (theorem.type === endType.toLowerCase()) {
          const rawContent = content.substring(theorem.startIndex, endIndex + fullMatch.length);
          const statement = this.extractStatement(rawContent);
          
          const theoremObj: Theorem = {
            type: theorem.type,
            name: theorem.name,
            label: theorem.label,
            statement,
            filePath,
            lineNumber: theorem.startLine,
            endLineNumber: endLine,
            rawContent,
            references: params.extract_references !== false ? this.extractReferences(rawContent) : [],
            symbols: params.extract_symbols !== false ? this.extractSymbols(rawContent) : [],
          };

          theorems.push(theoremObj);
          currentTheorem = i + 1;
          break;
        }
      }
    }

    // Generate summary
    const summary = this.generateSummary(theorems);

    return {
      theorems,
      summary,
    };
  }

  private getLineNumber(content: string, index: number): number {
    return content.substring(0, index).split('\n').length;
  }

  private extractStatement(rawContent: string): string {
    // Remove begin/end tags and extract the theorem statement
    const beginMatch = rawContent.match(/\\begin\{[^}]+\}(?:\[[^\]]*\])?(?:\{[^}]*\})?/);
    const endMatch = rawContent.match(/\\end\{[^}]+\}/);
    
    if (!beginMatch || !endMatch) {
      return rawContent.trim();
    }

    const start = beginMatch.index! + beginMatch[0].length;
    const end = rawContent.lastIndexOf(endMatch[0]);
    
    let statement = rawContent.substring(start, end).trim();
    
    // Clean up common LaTeX commands
    statement = statement.replace(/\\label\{[^}]*\}/g, '');
    statement = statement.replace(/^\s*\n+/gm, '');
    statement = statement.replace(/\s*\n+\s*$/gm, '');
    
    return statement;
  }

  private extractReferences(content: string): string[] {
    const references: string[] = [];
    
    // Extract \ref{} references
    const refPattern = /\\ref\{([^}]+)\}/g;
    let match;
    while ((match = refPattern.exec(content)) !== null) {
      references.push(match[1]);
    }
    
    // Extract \eqref{} references
    const eqrefPattern = /\\eqref\{([^}]+)\}/g;
    while ((match = eqrefPattern.exec(content)) !== null) {
      references.push(match[1]);
    }
    
    return [...new Set(references)]; // Remove duplicates
  }

  private extractSymbols(content: string): string[] {
    const symbols: string[] = [];
    
    // Common mathematical symbols and commands
    const symbolPatterns = [
      /\\([a-zA-Z]+)/g, // LaTeX commands like \alpha, \beta, etc.
      /\$([^$]+)\$/g,   // Inline math
      /\\\[([^\]]+)\\\]/g, // Display math
      /\\begin\{equation\}(.*?)\\end\{equation\}/gs, // Equation environments
      /\\begin\{align\}(.*?)\\end\{align\}/gs,       // Align environments
    ];
    
    for (const pattern of symbolPatterns) {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        const symbolContent = match[1];
        if (symbolContent) {
          // Extract individual symbols/commands
          const innerSymbols = symbolContent.match(/\\[a-zA-Z]+|[a-zA-Z]+|[∀∃∈∉⊆⊇∪∩∅∞]/g);
          if (innerSymbols) {
            symbols.push(...innerSymbols);
          }
        }
      }
    }
    
    return [...new Set(symbols)].sort(); // Remove duplicates and sort
  }

  private generateSummary(theorems: Theorem[]): TheoremExtractionResult['summary'] {
    const theoremsByType: Record<string, number> = {};
    const allSymbols: string[] = [];
    let totalReferences = 0;

    for (const theorem of theorems) {
      // Count by type
      theoremsByType[theorem.type] = (theoremsByType[theorem.type] || 0) + 1;
      
      // Collect symbols
      allSymbols.push(...theorem.symbols);
      
      // Count references
      totalReferences += theorem.references.length;
    }

    return {
      totalTheorems: theorems.length,
      theoremsByType,
      uniqueSymbols: [...new Set(allSymbols)].sort(),
      totalReferences,
    };
  }
}