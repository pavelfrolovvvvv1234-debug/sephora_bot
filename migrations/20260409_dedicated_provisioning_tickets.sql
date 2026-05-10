-- Dedicated provisioning workflow schema

CREATE TABLE IF NOT EXISTS dedicated_server_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  orderNumber VARCHAR NOT NULL UNIQUE,
  idempotencyKey VARCHAR NULL UNIQUE,
  userId INTEGER NOT NULL,
  telegramUserId INTEGER NULL,
  telegramUsername VARCHAR NULL,
  fullName VARCHAR NULL,
  email VARCHAR NULL,
  phone VARCHAR NULL,
  source VARCHAR NOT NULL DEFAULT 'telegram_bot',
  paymentId VARCHAR NULL,
  transactionId VARCHAR NULL,
  paymentMethod VARCHAR NULL,
  paymentStatus VARCHAR NOT NULL DEFAULT 'pending',
  paymentAmount REAL NOT NULL DEFAULT 0,
  currency VARCHAR NOT NULL DEFAULT 'USD',
  billingCycle VARCHAR NOT NULL DEFAULT 'monthly',
  promoCode VARCHAR NULL,
  discountAmount REAL NULL,
  balanceUsedAmount REAL NULL,
  customerLanguage VARCHAR NULL,
  customerNotes TEXT NULL,
  productId VARCHAR NOT NULL,
  productName VARCHAR NOT NULL,
  serverCategory VARCHAR NULL,
  locationKey VARCHAR NULL,
  locationLabel VARCHAR NULL,
  country VARCHAR NULL,
  osKey VARCHAR NULL,
  osLabel VARCHAR NULL,
  configurationSnapshot TEXT NULL,
  paidAt DATETIME NULL,
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_dedicated_server_orders_user_created
  ON dedicated_server_orders(userId, createdAt);
CREATE INDEX IF NOT EXISTS idx_dedicated_server_orders_payment_status
  ON dedicated_server_orders(paymentStatus, createdAt);
CREATE INDEX IF NOT EXISTS idx_dedicated_server_orders_location_product
  ON dedicated_server_orders(locationKey, productId);

CREATE TABLE IF NOT EXISTS provisioning_tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  orderId INTEGER NOT NULL UNIQUE,
  ticketNumber VARCHAR NOT NULL UNIQUE,
  status VARCHAR NOT NULL DEFAULT 'new',
  assigneeUserId INTEGER NULL,
  linkedLegacyTicketId INTEGER NULL,
  completedAt DATETIME NULL,
  cancelledAt DATETIME NULL,
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_provisioning_tickets_status_created
  ON provisioning_tickets(status, createdAt);
CREATE INDEX IF NOT EXISTS idx_provisioning_tickets_assignee_status
  ON provisioning_tickets(assigneeUserId, status);

CREATE TABLE IF NOT EXISTS provisioning_ticket_status_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticketId INTEGER NOT NULL,
  fromStatus VARCHAR NULL,
  toStatus VARCHAR NOT NULL,
  actorUserId INTEGER NOT NULL,
  note VARCHAR NULL,
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_prov_ticket_status_history_ticket_created
  ON provisioning_ticket_status_history(ticketId, createdAt);

CREATE TABLE IF NOT EXISTS provisioning_ticket_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticketId INTEGER NOT NULL,
  actorUserId INTEGER NOT NULL,
  isInternal BOOLEAN NOT NULL DEFAULT 1,
  text TEXT NOT NULL,
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_prov_ticket_notes_ticket_created
  ON provisioning_ticket_notes(ticketId, createdAt);

CREATE TABLE IF NOT EXISTS provisioning_ticket_assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticketId INTEGER NOT NULL,
  fromAssigneeUserId INTEGER NULL,
  toAssigneeUserId INTEGER NULL,
  actorUserId INTEGER NOT NULL,
  note VARCHAR NULL,
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_prov_ticket_assignments_ticket_created
  ON provisioning_ticket_assignments(ticketId, createdAt);

CREATE TABLE IF NOT EXISTS provisioning_ticket_checklist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticketId INTEGER NOT NULL,
  key VARCHAR NOT NULL,
  isChecked BOOLEAN NOT NULL DEFAULT 0,
  checkedByUserId INTEGER NULL,
  checkedAt DATETIME NULL,
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(ticketId, key)
);

CREATE TABLE IF NOT EXISTS provisioning_ticket_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticketId INTEGER NOT NULL,
  eventType VARCHAR NOT NULL,
  actorUserId INTEGER NULL,
  payload TEXT NULL,
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_prov_ticket_events_ticket_created
  ON provisioning_ticket_events(ticketId, createdAt);
CREATE INDEX IF NOT EXISTS idx_prov_ticket_events_type_created
  ON provisioning_ticket_events(eventType, createdAt);
