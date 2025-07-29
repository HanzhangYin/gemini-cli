/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach, Mock } from 'vitest';
import { GetProofTool, GetProofParams } from './get-proof.js';
import { Config } from '../config/config.js';
import { FileDiscoveryService } from '../services/fileDiscoveryService.js';
import * as fileUtils from '../utils/fileUtils.js';

// Mock fileUtils.processSingleFileContent
vi.mock('../utils/fileUtils', async () => {
  const actualFileUtils =
    await vi.importActual<typeof fileUtils>('../utils/fileUtils');
  return {
    ...actualFileUtils,
    processSingleFileContent: vi.fn(),
    isWithinRoot: vi.fn(),
  };
});

const mockProcessSingleFileContent = fileUtils.processSingleFileContent as Mock;
const mockIsWithinRoot = fileUtils.isWithinRoot as Mock;

describe('GetProofTool', () => {
  let tool: GetProofTool;
  let mockConfig: Config;
  let mockFileService: FileDiscoveryService;

  beforeEach(() => {
    mockFileService = {
      shouldGeminiIgnoreFile: vi.fn().mockReturnValue(false),
    } as any;

    mockConfig = {
      getTargetDir: vi.fn().mockReturnValue('/test/root'),
      getFileService: vi.fn().mockReturnValue(mockFileService),
    } as any;

    mockIsWithinRoot.mockReturnValue(true);
    tool = new GetProofTool(mockConfig);
  });

  describe('validateToolParams', () => {
    it('should validate valid parameters', () => {
      const params: GetProofParams = {
        absolute_path: '/test/root/document.tex',
        theorem_identifier: 'Main Theorem',
      };

      const result = tool.validateToolParams(params);
      expect(result).toBeNull();
    });

    it('should reject relative paths', () => {
      const params: GetProofParams = {
        absolute_path: 'document.tex',
        theorem_identifier: 'Main Theorem',
      };

      const result = tool.validateToolParams(params);
      expect(result).toContain('File path must be absolute');
    });

    it('should reject paths outside root directory', () => {
      mockIsWithinRoot.mockReturnValue(false);
      
      const params: GetProofParams = {
        absolute_path: '/other/path/document.tex',
        theorem_identifier: 'Main Theorem',
      };

      const result = tool.validateToolParams(params);
      expect(result).toContain('File path must be within the root directory');
    });

    it('should reject non-LaTeX files', () => {
      const params: GetProofParams = {
        absolute_path: '/test/root/document.txt',
        theorem_identifier: 'Main Theorem',
      };

      const result = tool.validateToolParams(params);
      expect(result).toContain('File must have a LaTeX extension');
    });

    it('should reject empty theorem identifier', () => {
      const params: GetProofParams = {
        absolute_path: '/test/root/document.tex',
        theorem_identifier: '   ',
      };

      const result = tool.validateToolParams(params);
      expect(result).toContain('Theorem identifier cannot be empty');
    });

    it('should reject ignored files', () => {
      vi.mocked(mockFileService.shouldGeminiIgnoreFile).mockReturnValue(true);
      
      const params: GetProofParams = {
        absolute_path: '/test/root/document.tex',
        theorem_identifier: 'Main Theorem',
      };

      const result = tool.validateToolParams(params);
      expect(result).toContain('is ignored by .geminiignore pattern(s)');
    });
  });

  describe('getDescription', () => {
    it('should generate description with file path and theorem identifier', () => {
      const params: GetProofParams = {
        absolute_path: '/test/root/math/document.tex',
        theorem_identifier: 'Fundamental Theorem',
      };

      const description = tool.getDescription(params);
      expect(description).toContain('Fundamental Theorem');
      expect(description).toContain('math/document.tex');
    });

    it('should handle invalid parameters gracefully', () => {
      const params = {} as GetProofParams;
      const description = tool.getDescription(params);
      expect(description).toBe('Get proof from LaTeX file');
    });
  });

  describe('proof extraction logic', () => {
    const sampleLatexContent = `
\\documentclass{article}
\\begin{document}

\\begin{theorem}[Fundamental Theorem]\\label{thm:fundamental}
Every continuous function on a closed interval attains its maximum and minimum.
\\end{theorem}

\\begin{proof}
Let $f: [a,b] \\to \\mathbb{R}$ be continuous. Since $[a,b]$ is compact and $f$ is continuous,
$f([a,b])$ is compact in $\\mathbb{R}$. Therefore, $f([a,b])$ is closed and bounded,
which means it contains its supremum and infimum.
\\end{proof}

\\begin{lemma}[Helper Lemma]\\label{lem:helper}
This is a helper lemma without a proof.
\\end{lemma}

\\begin{definition}
A function is continuous if...
\\end{definition}

\\end{document}
    `;

    it('should find theorem by exact label match', async () => {
      // Mock file reading
      mockProcessSingleFileContent.mockResolvedValue({
        llmContent: sampleLatexContent,
        error: null,
      });

      const params: GetProofParams = {
        absolute_path: '/test/root/document.tex',
        theorem_identifier: 'thm:fundamental',
      };

      const result = await tool.execute(params, new AbortController().signal);
      
      expect(result.llmContent).toContain('## Found Theorem');
      expect(result.llmContent).toContain('Fundamental Theorem');
      expect(result.llmContent).toContain('**Has Proof:** Yes');
      expect(result.llmContent).toContain('Let $f: [a,b]');
      expect(result.returnDisplay).toContain('Found theorem "thm:fundamental" with proof');
    });

    it('should find theorem by name match', async () => {
      mockProcessSingleFileContent.mockResolvedValue({
        llmContent: sampleLatexContent,
        error: null,
      });

      const params: GetProofParams = {
        absolute_path: '/test/root/document.tex',
        theorem_identifier: 'Fundamental Theorem',
      };

      const result = await tool.execute(params, new AbortController().signal);
      
      expect(result.llmContent).toContain('## Found Theorem');
      expect(result.llmContent).toContain('Fundamental Theorem');
      expect(result.llmContent).toContain('**Has Proof:** Yes');
    });

    it('should find theorem without proof', async () => {
      mockProcessSingleFileContent.mockResolvedValue({
        llmContent: sampleLatexContent,
        error: null,
      });

      const params: GetProofParams = {
        absolute_path: '/test/root/document.tex',
        theorem_identifier: 'Helper Lemma',
      };

      const result = await tool.execute(params, new AbortController().signal);
      
      expect(result.llmContent).toContain('## Found Theorem');
      expect(result.llmContent).toContain('Helper Lemma');
      expect(result.llmContent).toContain('**Has Proof:** No');
      expect(result.llmContent).toContain('## No Proof Found');
      expect(result.returnDisplay).toContain('Found theorem "Helper Lemma" but no proof');
    });

    it('should handle fuzzy matching', async () => {
      mockProcessSingleFileContent.mockResolvedValue({
        llmContent: sampleLatexContent,
        error: null,
      });

      const params: GetProofParams = {
        absolute_path: '/test/root/document.tex',
        theorem_identifier: 'continuous function maximum',
        fuzzy_match: true,
      };

      const result = await tool.execute(params, new AbortController().signal);
      
      expect(result.llmContent).toContain('## Found Theorem');
      expect(result.llmContent).toContain('Fundamental Theorem');
    });

    it('should return potential matches when theorem not found', async () => {
      mockProcessSingleFileContent.mockResolvedValue({
        llmContent: sampleLatexContent,
        error: null,
      });

      const params: GetProofParams = {
        absolute_path: '/test/root/document.tex',
        theorem_identifier: 'Nonexistent Theorem',
      };

      const result = await tool.execute(params, new AbortController().signal);
      
      expect(result.llmContent).toContain('No Matching Theorem Found');
      expect(result.llmContent).toContain('Potential Matches');
      expect(result.returnDisplay).toContain('No theorem found matching');
    });

    it('should filter by theorem types', async () => {
      mockProcessSingleFileContent.mockResolvedValue({
        llmContent: sampleLatexContent,
        error: null,
      });

      const params: GetProofParams = {
        absolute_path: '/test/root/document.tex',
        theorem_identifier: 'Helper',
        theorem_types: ['lemma'],
      };

      const result = await tool.execute(params, new AbortController().signal);
      
      expect(result.llmContent).toContain('## Found Theorem');
      expect(result.llmContent).toContain('Helper Lemma');
    });
  });

  describe('error handling', () => {
    it('should handle file reading errors', async () => {
      mockProcessSingleFileContent.mockResolvedValue({
        error: 'File not found',
        returnDisplay: 'File not found',
      });

      const params: GetProofParams = {
        absolute_path: '/test/root/nonexistent.tex',
        theorem_identifier: 'Any Theorem',
      };

      const result = await tool.execute(params, new AbortController().signal);
      
      expect(result.llmContent).toBe('File not found');
      expect(result.returnDisplay).toBe('File not found');
    });

    it('should handle non-text files', async () => {
      mockProcessSingleFileContent.mockResolvedValue({
        llmContent: Buffer.from('binary data'),
        error: null,
      });

      const params: GetProofParams = {
        absolute_path: '/test/root/binary.tex',
        theorem_identifier: 'Any Theorem',
      };

      const result = await tool.execute(params, new AbortController().signal);
      
      expect(result.llmContent).toBe('Error: File content is not text');
      expect(result.returnDisplay).toBe('Error: File must be a text file');
    });

    it('should handle aborted signals', async () => {
      // Mock the signal check to throw an error when aborted
      mockProcessSingleFileContent.mockImplementation(() => {
        return Promise.resolve({
          llmContent: `\\begin{theorem}
Test content
\\end{theorem}`,
          error: null,
        });
      });

      const params: GetProofParams = {
        absolute_path: '/test/root/document.tex',
        theorem_identifier: 'Any Theorem',
      };

      const abortController = new AbortController();
      abortController.abort();

      const result = await tool.execute(params, abortController.signal);
      
      // The abort signal is properly handled and throws an error
      expect(result.llmContent).toContain('Error finding proof');
      expect(result.returnDisplay).toContain('Error:');
    });
  });
});