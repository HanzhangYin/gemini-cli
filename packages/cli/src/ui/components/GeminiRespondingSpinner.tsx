/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Text } from 'ink';
import Spinner from 'ink-spinner';
import { useStreamingContext } from '../contexts/StreamingContext.js';
import { StreamingState } from '../types.js';

// Define spinner types that are compatible with ink-spinner's bundled cli-spinners version
type CompatibleSpinnerName = 
  | 'dots'
  | 'dots2'
  | 'dots3'
  | 'dots4'
  | 'dots5'
  | 'dots6'
  | 'dots7'
  | 'dots8'
  | 'dots9'
  | 'dots10'
  | 'dots11'
  | 'dots12'
  | 'dots8Bit'
  | 'sand'
  | 'line'
  | 'line2'
  | 'pipe'
  | 'simpleDots'
  | 'simpleDotsScrolling'
  | 'star'
  | 'star2'
  | 'flip'
  | 'hamburger'
  | 'growVertical'
  | 'growHorizontal'
  | 'balloon'
  | 'balloon2'
  | 'noise'
  | 'bounce'
  | 'boxBounce'
  | 'boxBounce2'
  | 'binary'
  | 'triangle'
  | 'arc'
  | 'circle'
  | 'squareCorners'
  | 'circleQuarters'
  | 'circleHalves'
  | 'squish'
  | 'toggle'
  | 'toggle2'
  | 'toggle3'
  | 'toggle4'
  | 'toggle5'
  | 'toggle6'
  | 'toggle7'
  | 'toggle8'
  | 'toggle9'
  | 'toggle10'
  | 'toggle11'
  | 'toggle12'
  | 'toggle13'
  | 'arrow'
  | 'arrow2'
  | 'arrow3'
  | 'bouncingBar'
  | 'bouncingBall'
  | 'smiley'
  | 'monkey'
  | 'hearts'
  | 'clock'
  | 'earth'
  | 'material'
  | 'moon'
  | 'runner'
  | 'pong'
  | 'shark'
  | 'dqpb'
  | 'weather'
  | 'christmas'
  | 'grenade'
  | 'point'
  | 'layer'
  | 'betaWave'
  | 'fingerDance'
  | 'fistBump'
  | 'soccerHeader'
  | 'mindblown'
  | 'speaker'
  | 'orangePulse'
  | 'bluePulse'
  | 'orangeBluePulse'
  | 'timeTravel'
  | 'aesthetic'
  | 'dwarfFortress';

interface GeminiRespondingSpinnerProps {
  /**
   * Optional string to display when not in Responding state.
   * If not provided and not Responding, renders null.
   */
  nonRespondingDisplay?: string;
  spinnerType?: CompatibleSpinnerName;
}

export const GeminiRespondingSpinner: React.FC<
  GeminiRespondingSpinnerProps
> = ({ nonRespondingDisplay, spinnerType = 'dots3' }) => {
  const streamingState = useStreamingContext();

  if (streamingState === StreamingState.Responding) {
    return <Spinner type={spinnerType} />;
  } else if (nonRespondingDisplay) {
    return <Text>{nonRespondingDisplay}</Text>;
  }
  return null;
};
