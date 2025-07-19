/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'path';
import { BaseTool, ToolResult, Icon } from './tools.js';
import { Type } from '@google/genai';
import { SchemaValidator } from '../utils/schemaValidator.js';
import { makeRelative, shortenPath } from '../utils/paths.js';
import { isWithinRoot, processSingleFileContent } from '../utils/fileUtils.js';
import { Config } from '../config/config.js';
import { getErrorMessage } from '../utils/errors.js';

/**
 * Represents a mathematical theorem with indexing information
 */
export interface IndexedTheorem {
  /** Unique identifier for the theorem */
  id: string;
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
  /** Theorems that this theorem depends on */
  dependencies: string[];
  /** Theorems that depend on this theorem */
  dependents: string[];
  /** Index within the document */
  index: number;
}

/**
 * Represents the index structure for theorems
 */
export interface TheoremIndex {
  /** Map of theorem labels to their IDs */
  labelToId: Record<string, string>;
  /** Map of theorem IDs to their full information */
  theorems: Record<string, IndexedTheorem>;
  /** Map of theorem types to their theorem IDs */
  typeIndex: Record<string, string[]>;
  /** Map of symbols to theorem IDs that use them */
  symbolIndex: Record<string, string[]>;
  /** Dependency graph: theorem ID -> list of theorem IDs it depends on */
  dependencyGraph: Record<string, string[]>;
  /** Reverse dependency graph: theorem ID -> list of theorem IDs that depend on it */
  reverseDependencyGraph: Record<string, string[]>;
}

/**
 * Parameters for the TheoremIndexer tool
 */
export interface TheoremIndexerParams {
  /** The absolute path to the LaTeX file to analyze */
  absolute_path: string;
  /** Optional: specific theorem types to extract (theorem, lemma, corollary, etc.) */
  theorem_types?: string[];
  /** Optional: whether to extract mathematical symbols */
  extract_symbols?: boolean;
  /** Optional: whether to extract references */
  extract_references?: boolean;
  /** Optional: whether to build dependency graph */
  build_dependencies?: boolean;
}

/**
 * Result of theorem indexing
 */
export interface TheoremIndexingResult {
  /** The complete theorem index */
  index: TheoremIndex;
  /** List of indexed theorems */
  theorems: IndexedTheorem[];
  /** Summary statistics */
  summary: {
    totalTheorems: number;
    theoremsByType: Record<string, number>;
    uniqueSymbols: string[];
    totalReferences: number;
    totalDependencies: number;
    orphanedTheorems: number;
    cyclicDependencies: string[][];
  };
}

/**
 * Tool for extracting, indexing, and analyzing mathematical theorems from LaTeX documents
 */
export class TheoremIndexerTool extends BaseTool<TheoremIndexerParams, ToolResult> {
  static readonly Name = 'index_theorems';

  constructor(private config: Config) {
    super(
      TheoremIndexerTool.Name,
      'TheoremIndexer',
      'Extracts, indexes, and analyzes mathematical theorems from LaTeX documents. Creates comprehensive index with dependencies, cross-references, and relationship mapping.',
      Icon.FileSearch,
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
          build_dependencies: {
            description: 'Optional: Whether to build dependency graph between theorems (default: true)',
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

  validateToolParams(params: TheoremIndexerParams): string | null {
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

  getDescription(params: TheoremIndexerParams): string {
    if (!params || typeof params.absolute_path !== 'string') {
      return 'Index theorems from LaTeX file';
    }
    const relativePath = makeRelative(params.absolute_path, this.config.getTargetDir());
    const types = params.theorem_types?.length ? ` (${params.theorem_types.join(', ')})` : '';
    return `Index theorems from ${shortenPath(relativePath)}${types}`;
  }

  async execute(params: TheoremIndexerParams, signal: AbortSignal): Promise<ToolResult> {
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

      // Index theorems from the content
      const indexingResult = await this.indexTheorems(
        fileResult.llmContent,
        params.absolute_path,
        params,
        signal,
      );

      // Format the result
      const relativePath = makeRelative(params.absolute_path, this.config.getTargetDir());
      let llmContent = `# Theorem Indexing Results\n\n`;
      llmContent += `**File:** ${relativePath}\n`;
      llmContent += `**Total Theorems:** ${indexingResult.summary.totalTheorems}\n`;
      llmContent += `**Total Dependencies:** ${indexingResult.summary.totalDependencies}\n`;
      llmContent += `**Orphaned Theorems:** ${indexingResult.summary.orphanedTheorems}\n\n`;

      if (indexingResult.summary.totalTheorems === 0) {
        llmContent += 'No theorems found in the specified file.\n';
      } else {
        // Summary by type
        llmContent += `## Summary by Type\n\n`;
        for (const [type, count] of Object.entries(indexingResult.summary.theoremsByType)) {
          llmContent += `- **${type}**: ${count}\n`;
        }
        llmContent += '\n';

        // Cyclic dependencies warning
        if (indexingResult.summary.cyclicDependencies.length > 0) {
          llmContent += `## ⚠️ Cyclic Dependencies Detected\n\n`;
          for (const cycle of indexingResult.summary.cyclicDependencies) {
            llmContent += `- ${cycle.join(' → ')}\n`;
          }
          llmContent += '\n';
        }

        // Theorem index
        llmContent += `## Theorem Index\n\n`;
        for (const theorem of indexingResult.theorems) {
          llmContent += `### ${theorem.index}. ${theorem.type.charAt(0).toUpperCase() + theorem.type.slice(1)}`;
          if (theorem.name) {
            llmContent += ` (${theorem.name})`;
          }
          llmContent += `\n\n`;
          
          llmContent += `**ID:** ${theorem.id}\n`;
          llmContent += `**Location:** Lines ${theorem.lineNumber}-${theorem.endLineNumber}\n`;
          if (theorem.label) {
            llmContent += `**Label:** ${theorem.label}\n`;
          }
          llmContent += `**Statement:** ${theorem.statement}\n\n`;
          
          if (theorem.dependencies.length > 0) {
            llmContent += `**Dependencies:** ${theorem.dependencies.join(', ')}\n`;
          }
          
          if (theorem.dependents.length > 0) {
            llmContent += `**Dependents:** ${theorem.dependents.join(', ')}\n`;
          }
          
          if (theorem.references.length > 0) {
            llmContent += `**References:** ${theorem.references.join(', ')}\n`;
          }
          
          if (theorem.symbols.length > 0) {
            llmContent += `**Symbols:** ${theorem.symbols.join(', ')}\n`;
          }
          
          llmContent += `**Raw LaTeX:**\n\`\`\`latex\n${theorem.rawContent}\n\`\`\`\n\n`;
        }

        // Symbol index
        if (indexingResult.summary.uniqueSymbols.length > 0) {
          llmContent += `## Symbol Index\n\n`;
          const symbolEntries = Object.entries(indexingResult.index.symbolIndex);
          for (const [symbol, theoremIds] of symbolEntries) {
            llmContent += `**${symbol}:** Used in ${theoremIds.length} theorem(s) - ${theoremIds.join(', ')}\n`;
          }
          llmContent += '\n';
        }

        // Dependency graph
        if (params.build_dependencies !== false) {
          llmContent += `## Dependency Graph\n\n`;
          const hasAnyDependencies = Object.values(indexingResult.index.dependencyGraph).some(deps => deps.length > 0);
          if (hasAnyDependencies) {
            for (const [theoremId, dependencies] of Object.entries(indexingResult.index.dependencyGraph)) {
              if (dependencies.length > 0) {
                llmContent += `**${theoremId}** depends on: ${dependencies.join(', ')}\n`;
              }
            }
          } else {
            llmContent += 'No dependencies found between theorems.\n';
          }
          llmContent += '\n';
        }
      }

      const displaySummary = `Indexed ${indexingResult.summary.totalTheorems} theorems with ${indexingResult.summary.totalDependencies} dependencies`;

      return {
        llmContent,
        returnDisplay: displaySummary,
      };
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      return {
        llmContent: `Error indexing theorems: ${errorMessage}`,
        returnDisplay: `Error: ${errorMessage}`,
      };
    }
  }

  private async indexTheorems(
    content: string,
    filePath: string,
    params: TheoremIndexerParams,
    signal: AbortSignal,
  ): Promise<TheoremIndexingResult> {
    const theorems: IndexedTheorem[] = [];
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
        throw new Error('Theorem indexing was aborted');
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
    let theoremCounter = 0;
    
    while ((match = endPattern.exec(content)) !== null) {
      if (signal.aborted) {
        throw new Error('Theorem indexing was aborted');
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
          const theoremId = this.generateTheoremId(theorem.type, theorem.label, theoremCounter++);
          
          const theoremObj: IndexedTheorem = {
            id: theoremId,
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
            dependencies: [],
            dependents: [],
            index: theoremCounter,
          };

          theorems.push(theoremObj);
          currentTheorem = i + 1;
          break;
        }
      }
    }

    // Build comprehensive index
    const index = this.buildIndex(theorems, params.build_dependencies !== false);
    
    // Generate summary with additional indexing statistics
    const summary = this.generateIndexingSummary(theorems, index);

    return {
      index,
      theorems,
      summary,
    };
  }

  private generateTheoremId(type: string, label?: string, counter: number = 0): string {
    if (label) {
      return label;
    }
    return `${type}_${counter + 1}`;
  }

  private buildIndex(theorems: IndexedTheorem[], buildDependencies: boolean): TheoremIndex {
    const index: TheoremIndex = {
      labelToId: {},
      theorems: {},
      typeIndex: {},
      symbolIndex: {},
      dependencyGraph: {},
      reverseDependencyGraph: {},
    };

    // Build basic indices
    for (const theorem of theorems) {
      // Label to ID mapping
      if (theorem.label) {
        index.labelToId[theorem.label] = theorem.id;
      }

      // Theorem storage
      index.theorems[theorem.id] = theorem;

      // Type index
      if (!index.typeIndex[theorem.type]) {
        index.typeIndex[theorem.type] = [];
      }
      index.typeIndex[theorem.type].push(theorem.id);

      // Symbol index
      for (const symbol of theorem.symbols) {
        if (!index.symbolIndex[symbol]) {
          index.symbolIndex[symbol] = [];
        }
        index.symbolIndex[symbol].push(theorem.id);
      }

      // Initialize dependency arrays
      index.dependencyGraph[theorem.id] = [];
      index.reverseDependencyGraph[theorem.id] = [];
    }

    // Build dependency graph
    if (buildDependencies) {
      for (const theorem of theorems) {
        for (const reference of theorem.references) {
          const referencedId = index.labelToId[reference];
          if (referencedId && referencedId !== theorem.id) {
            // Add dependency
            index.dependencyGraph[theorem.id].push(referencedId);
            index.reverseDependencyGraph[referencedId].push(theorem.id);
            
            // Update theorem objects
            theorem.dependencies.push(referencedId);
            const referencedTheorem = index.theorems[referencedId];
            if (referencedTheorem) {
              referencedTheorem.dependents.push(theorem.id);
            }
          }
        }
      }
    }

    return index;
  }

  private detectCyclicDependencies(dependencyGraph: Record<string, string[]>): string[][] {
    const cycles: string[][] = [];
    const visited = new Set<string>();
    const recursionStack = new Set<string>();

    const dfs = (node: string, path: string[]): void => {
      if (recursionStack.has(node)) {
        // Found a cycle
        const cycleStart = path.indexOf(node);
        cycles.push([...path.slice(cycleStart), node]);
        return;
      }

      if (visited.has(node)) {
        return;
      }

      visited.add(node);
      recursionStack.add(node);
      path.push(node);

      const dependencies = dependencyGraph[node] || [];
      for (const dep of dependencies) {
        dfs(dep, path);
      }

      recursionStack.delete(node);
      path.pop();
    };

    for (const node of Object.keys(dependencyGraph)) {
      if (!visited.has(node)) {
        dfs(node, []);
      }
    }

    return cycles;
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

  private generateIndexingSummary(theorems: IndexedTheorem[], index: TheoremIndex): TheoremIndexingResult['summary'] {
    const theoremsByType: Record<string, number> = {};
    const allSymbols: string[] = [];
    let totalReferences = 0;
    let totalDependencies = 0;

    for (const theorem of theorems) {
      // Count by type
      theoremsByType[theorem.type] = (theoremsByType[theorem.type] || 0) + 1;
      
      // Collect symbols
      allSymbols.push(...theorem.symbols);
      
      // Count references
      totalReferences += theorem.references.length;
      
      // Count dependencies
      totalDependencies += theorem.dependencies.length;
    }

    // Count orphaned theorems (no dependencies and no dependents)
    const orphanedTheorems = theorems.filter(
      theorem => theorem.dependencies.length === 0 && theorem.dependents.length === 0
    ).length;

    // Detect cyclic dependencies
    const cyclicDependencies = this.detectCyclicDependencies(index.dependencyGraph);

    return {
      totalTheorems: theorems.length,
      theoremsByType,
      uniqueSymbols: [...new Set(allSymbols)].sort(),
      totalReferences,
      totalDependencies,
      orphanedTheorems,
      cyclicDependencies,
    };
  }
}