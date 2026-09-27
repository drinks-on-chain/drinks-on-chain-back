#![no_std]
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, Address, BytesN, Env,
    String, Symbol, Vec,
};

// Constantes para la gestión de TTL en almacenamiento persistente
const LEDGER_BUMP_THRESHOLD: u32 = 172_800; // ~10 días en ledgers (asumiendo ~5 seg/ledger)
const LEDGER_EXTEND_AMOUNT: u32 = 518_400;  // ~30 días de extensión

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    Unauthorized = 3,
    BatchAlreadyExists = 4,
    BatchNotFound = 5,
    InvalidStageTransition = 6,
    ParentBatchNotFound = 7,
}

#[contracttype]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u32)]
pub enum Role {
    Admin = 0,
    Agronomist = 1,  // Origen / Parcela
    Weigher = 2,     // Vendimia / Pesaje
    Oenologist = 3,  // Vinificación / Crianza
    Distiller = 4,   // Destilación Singani
    Packer = 5,      // Dilución y Embotellado
    Certifier = 6,   // Laboratorio / SENASAG
    Exporter = 7,    // Despacho Aduanero
}

#[contracttype]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u32)]
pub enum Stage {
    Plot = 0,        // Polígono del Viñedo
    Harvest = 1,     // Vendimia e Inocuidad Inicial
    Vinification = 2,// Fermentación / Vino Base
    Aging = 3,       // Crianza en Barrica (Vino)
    Distillation = 4,// Destilación y Reposo Inerte (Singani)
    Bottling = 5,    // Dilución, Envasado e Identidad QR
    Export = 6,      // Despacho y Consolidación Internacional
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct LabCertification {
    pub certifier: Address,
    pub report_ipfs_cid: BytesN<32>,
    pub is_approved: bool,
    pub timestamp: u64,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct BatchRecord {
    pub stage: Stage,
    pub actor: Address,
    pub parents: Vec<BytesN<32>>,    // IDs de lotes predecesores (Grafo DAG)
    pub ipfs_cid_hash: BytesN<32>,   // Hash del CID de metadata en IPFS
    pub volume_or_units: u64,        // Balance de masa: Kg, Litros o Botellas
    pub metrics: Vec<u32>,           // Métricas numéricas [°Bx*100, ABV*100, etc.]
    pub timestamp: u64,
    pub is_certified: bool,
    pub certification: Option<LabCertification>,
}

#[contracttype]
pub enum DataKey {
    Admin,
    Role(Address, Role),
    Batch(BytesN<32>),
}

#[contract]
pub struct TraceabilityContract;

#[contractimpl]
impl TraceabilityContract {
    /// Inicializa el contrato definiendo el administrador inicial
    pub fn initialize(env: Env, admin: Address) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AlreadyInitialized);
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        
        // Asignar rol Admin al administrador
        env.storage().persistent().set(&DataKey::Role(admin.clone(), Role::Admin), &true);
        
        Ok(())
    }

    /// Otorga o revoca roles de operación a cuentas específicas
    pub fn set_role(
        env: Env,
        admin: Address,
        account: Address,
        role: Role,
        authorized: bool,
    ) -> Result<(), Error> {
        admin.require_auth();
        let current_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;

        if admin != current_admin {
            return Err(Error::Unauthorized);
        }

        let key = DataKey::Role(account.clone(), role);
        if authorized {
            env.storage().persistent().set(&key, &true);
            env.storage().persistent().extend_ttl(&key, LEDGER_BUMP_THRESHOLD, LEDGER_EXTEND_AMOUNT);
        } else {
            env.storage().persistent().remove(&key);
        }

        env.events().publish(
            (symbol_short!("role_upd"), account),
            (role as u32, authorized),
        );

        Ok(())
    }

    /// Registra una nueva etapa de trazabilidad en la cadena
    pub fn record_stage(
        env: Env,
        actor: Address,
        batch_id: BytesN<32>,
        stage: Stage,
        parents: Vec<BytesN<32>>,
        ipfs_cid_hash: BytesN<32>,
        volume_or_units: u64,
        metrics: Vec<u32>,
    ) -> Result<(), Error> {
        actor.require_auth();

        // 1. Validar autorización del actor según la etapa
        Self::validate_stage_permission(&env, &actor, stage)?;

        // 2. Verificar que el lote no exista previamente
        let batch_key = DataKey::Batch(batch_id.clone());
        if env.storage().persistent().has(&batch_key) {
            return Err(Error::BatchAlreadyExists);
        }

        // 3. Validar existencia de los lotes padres si no es etapa inicial (Plot)
        if stage != Stage::Plot {
            for parent_id in parents.iter() {
                let parent_key = DataKey::Batch(parent_id);
                if !env.storage().persistent().has(&parent_key) {
                    return Err(Error::ParentBatchNotFound);
                }
            }
        }

        let record = BatchRecord {
            stage,
            actor: actor.clone(),
            parents,
            ipfs_cid_hash,
            volume_or_units,
            metrics,
            timestamp: env.ledger().timestamp(),
            is_certified: false,
            certification: None,
        };

        // 4. Guardar registro y extender TTL
        env.storage().persistent().set(&batch_key, &record);
        env.storage().persistent().extend_ttl(
            &batch_key,
            LEDGER_BUMP_THRESHOLD,
            LEDGER_EXTEND_AMOUNT,
        );

        // 5. Emitir evento on-chain para indexadores
        env.events().publish(
            (symbol_short!("stage_rec"), batch_id),
            (stage as u32, actor, volume_or_units),
        );

        Ok(())
    }

    /// Certifica un lote mediante análisis de laboratorio o aval de SENASAG
    pub fn certify_batch(
        env: Env,
        certifier: Address,
        batch_id: BytesN<32>,
        report_ipfs_cid: BytesN<32>,
        is_approved: bool,
    ) -> Result<(), Error> {
        certifier.require_auth();

        // Verificar rol de certificador
        if !Self::has_role(&env, &certifier, Role::Certifier) {
            return Err(Error::Unauthorized);
        }

        let batch_key = DataKey::Batch(batch_id.clone());
        let mut record: BatchRecord = env
            .storage()
            .persistent()
            .get(&batch_key)
            .ok_or(Error::BatchNotFound)?;

        let cert = LabCertification {
            certifier: certifier.clone(),
            report_ipfs_cid,
            is_approved,
            timestamp: env.ledger().timestamp(),
        };

        record.is_certified = is_approved;
        record.certification = Some(cert);

        env.storage().persistent().set(&batch_key, &record);
        env.storage().persistent().extend_ttl(
            &batch_key,
            LEDGER_BUMP_THRESHOLD,
            LEDGER_EXTEND_AMOUNT,
        );

        env.events().publish(
            (symbol_short!("batch_crt"), batch_id),
            (certifier, is_approved),
        );

        Ok(())
    }

    /// Consulta pública de un lote (Lectura gratuita sin gas vía RPC)
    pub fn get_batch(env: Env, batch_id: BytesN<32>) -> Result<BatchRecord, Error> {
        let batch_key = DataKey::Batch(batch_id);
        env.storage()
            .persistent()
            .get(&batch_key)
            .ok_or(Error::BatchNotFound)
    }

    /// Verifica si una cuenta tiene un rol específico
    pub fn has_role(env: Env, account: &Address, role: Role) -> bool {
        let key = DataKey::Role(account.clone(), role);
        env.storage().persistent().get(&key).unwrap_or(false)
    }

    // --- Funciones internas auxiliares ---

    fn validate_stage_permission(env: &Env, actor: &Address, stage: Stage) -> Result<(), Error> {
        let required_role = match stage {
            Stage::Plot => Role::Agronomist,
            Stage::Harvest => Role::Weigher,
            Stage::Vinification => Role::Oenologist,
            Stage::Aging => Role::Oenologist,
            Stage::Distillation => Role::Distiller,
            Stage::Bottling => Role::Packer,
            Stage::Export => Role::Exporter,
        };

        if Self::has_role(env, actor, required_role) || Self::has_role(env, actor, Role::Admin) {
            Ok(())
        } else {
            Err(Error::Unauthorized)
        }
    }
}

// ==========================================
// PRUEBAS UNITARIAS (TESTS)
// ==========================================
#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::{Address as _, Ledger};
    use soroban_sdk::Env;

    #[test]
    fn test_complete_traceability_flow() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(TraceabilityContract, ());
        let client = TraceabilityContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let agronomist = Address::generate(&env);
        let weigher = Address::generate(&env);
        let distiller = Address::generate(&env);
        let lab = Address::generate(&env);

        client.initialize(&admin);

        // Asignación de roles
        client.set_role(&admin, &agronomist, &Role::Agronomist, &true);
        client.set_role(&admin, &weigher, &Role::Weigher, &true);
        client.set_role(&admin, &distiller, &Role::Distiller, &true);
        client.set_role(&admin, &lab, &Role::Certifier, &true);

        // 1. Registro de Parcela / Viñedo
        let plot_id = BytesN::from_array(&env, &[1u8; 32]);
        let ipfs_dummy = BytesN::from_array(&env, &[9u8; 32]);
        let mut plot_metrics = Vec::new(&env);
        plot_metrics.push_back(1850); // 1,850 m.s.n.m.

        client.record_stage(
            &agronomist,
            &plot_id,
            &Stage::Plot,
            &Vec::new(&env),
            &ipfs_dummy,
            &15000,
            &plot_metrics,
        );

        // 2. Vendimia y Pesaje
        let harvest_id = BytesN::from_array(&env, &[2u8; 32]);
        let mut harvest_parents = Vec::new(&env);
        harvest_parents.push_back(plot_id);

        let mut harvest_metrics = Vec::new(&env);
        harvest_metrics.push_back(2240); // 22.40 °Bx

        client.record_stage(
            &weigher,
            &harvest_id,
            &Stage::Harvest,
            &harvest_parents,
            &ipfs_dummy,
            &14850,
            &harvest_metrics,
        );

        // 3. Certificación de Laboratorio
        client.certify_batch(&lab, &harvest_id, &ipfs_dummy, &true);

        // 4. Verificación de consulta
        let record = client.get_batch(&harvest_id);
        assert_eq!(record.volume_or_units, 14850);
        assert_eq!(record.is_certified, true);
    }
}