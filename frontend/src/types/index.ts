/* ── TypeScript types matching backend Pydantic schemas ── */

// ── Auth ──
export interface UserCreate {
  username: string;
  email: string;
  password: string;
}

export interface UserLogin {
  username: string;
  password: string;
}

export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
}

export interface User {
  id: string;
  username: string;
  email: string;
  role: string;
  is_active: boolean;
  created_at: string;
}

// ── Devices ──
export interface DeviceCreate {
  name: string;
  device_type?: string;
  ip_address?: string;
  protocol?: string;
  port?: number;
  traffic_source?: string;
  description?: string;
  client_id?: number;
}

export interface DeviceUpdate {
  name?: string;
  device_type?: string;
  ip_address?: string;
  protocol?: string;
  port?: number;
  status?: string;
  traffic_source?: string;
  description?: string;
  client_id?: number;
}

export interface Device {
  id: string;
  name: string;
  device_type: string;
  ip_address: string | null;
  protocol: string;
  port: number;
  status: string;
  traffic_source: string;
  description: string | null;
  client_id: number | null;
  last_seen_at: string | null;
  threat_count_today: number;
  created_at: string;
  updated_at: string | null;
}

// ── FL ──
export interface FLRound {
  id: number;
  round_number: number;
  num_clients: number;
  global_loss: number | null;
  global_accuracy: number | null;
  global_f1: number | null;
  global_precision: number | null;
  global_recall: number | null;
  aggregation_method: string;
  he_scheme: string | null;
  he_poly_modulus?: number | null;
  duration_seconds: number | null;
}

export interface FLClientMetric {
  id: number;
  round_id: number;
  client_id: string;
  local_loss: number;
  local_accuracy: number;
  num_samples: number;
  training_time_sec: number;
  encrypted: boolean;
}

export interface FLRoundDetail extends FLRound {
  client_metrics: FLClientMetric[];
}

export interface FLClient {
  id: number;
  client_id: string;
  name: string;
  description: string | null;
  ip_address: string | null;
  status: string;
  data_path: string;
  container_id: string | null;
  container_name: string | null;
  total_samples: number;
  last_seen_at: string | null;
  created_at: string;
  updated_at: string | null;
}

export interface DeviceBrief {
  id: string;
  name: string;
  device_type: string;
  status: string;
  ip_address: string | null;
}

export interface FLClientDetail extends FLClient {
  devices: DeviceBrief[];
}

export interface FLClientCreate {
  client_id: string;
  name: string;
  description?: string;
  ip_address?: string;
  data_path?: string;
}

export interface FLClientUpdate {
  name?: string;
  description?: string;
  ip_address?: string;
  status?: string;
  data_path?: string;
  total_samples?: number;
}

export interface ContainerStatus {
  container_id: string | null;
  name: string | null;
  status: string;
  image: string | null;
}

export interface FLStatus {
  is_training: boolean;
  current_round: number | null;
  total_rounds: number | null;
  active_clients: number;
  total_rounds_completed: number;
}

// ── Predictions ──
export interface PredictRequest {
  device_id: string;
  features: number[][];
}

export interface PredictResult {
  score: number;
  label: string;
  confidence: number;
  inference_latency_ms: number;
  model_version: string;
}

export interface PredictResponse {
  prediction: PredictResult;
  saved: boolean;
  prediction_id: number | null;
}

export interface Prediction {
  id: number;
  device_id: string;
  score: number;
  label: string;
  confidence: number;
  attack_type: string | null;
  model_version: string;
  inference_latency_ms: number;
  timestamp: string;
}

export interface PredictionSummary {
  total_predictions: number;
  attack_count: number;
  benign_count: number;
  attack_rate: number;
  avg_confidence: number;
  avg_latency_ms: number;
}

export interface ModelInfo {
  loaded: boolean;
  version: string | null;
  path: string | null;
  architecture: string;
  input_shape: string;
  threshold: number;
}
