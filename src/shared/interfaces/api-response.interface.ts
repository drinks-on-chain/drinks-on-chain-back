export interface ApiSuccessResponse<T> {
  success: true;
  statusCode: number;
  timestamp: string;
  path: string;
  data: T;
}

export interface ApiErrorResponse {
  success: false;
  statusCode: number;
  timestamp: string;
  path: string;
  error: {
    code: string;
    message: string;
    details: unknown | null;
  };
}

export interface PaginatedData<T> {
  items: T[];
  pagination: PaginationMeta;
}

export interface PaginationMeta {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPrevPage: boolean;
}
